"""Gemini as the provider of the page read and of the independent second read.

Talks to the generateContent REST endpoint directly (stdlib only, no SDK to install) in structured-output mode:
the model must answer JSON matching a response schema, and an answer that is not valid JSON or does not match
the schema is an error (retried, then raised), never accepted quietly.

Privacy: logs carry only the stage / field name, status and timing. Never the image, a value, or a response body.
"""
import asyncio
import json
import random
import socket
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

from app.fields import FIELD_NAMES, MULTI_FIELDS
from app.logging_utils import get_logger, log_event
from pipeline.base import Context, FieldResult
from pipeline.claude_client import AdaptiveLimiter, ApiUnavailable, make_ssl_context
from pipeline.learning import lessons_of
from pipeline.normalizers import same_reading
from pipeline.stages.extract import FIELD_HINTS, encode_page, parse_box

log = get_logger("gemini")

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
SCRIPTS = ["handwritten", "printed"]
RETRY_STATUS = (429, 500, 502, 503, 504)
QUOTA_BACKOFF = 3600.0  # when the API does not say when a used-up quota resets: look again in an hour
LONG_WAIT = 120.0  # a 429 that asks for longer than this is a quota, not a burst of requests


class GeminiError(RuntimeError):
    code = "gemini_error"


class InvalidModelResponse(GeminiError):
    """The answer is not valid JSON, is blocked / cut short, or does not match the response schema."""
    code = "invalid_model_response"


class GeminiRequestRejected(GeminiError):
    """The API rejected the request itself (bad schema, unknown model...): retrying cannot help."""
    code = "gemini_request_rejected"


class GeminiQuotaExhausted(ApiUnavailable):
    """The key's quota for the day (or the month) is used up: every call fails until it resets, so retrying is
    pointless. Carries how long until it does, when the API says."""

    def __init__(self, retry_in: Optional[float] = None):
        super().__init__("quota")
        self.retry_in = retry_in


class _Transient(GeminiError):
    def __init__(self, status: int, retry_after: Optional[float] = None):
        super().__init__(f"http {status}")
        self.status, self.retry_after = status, retry_after


class _Unreachable(GeminiError):
    def __init__(self, timed_out: bool):
        super().__init__("timeout" if timed_out else "connection failed")
        self.timed_out = timed_out


Send = Callable[[str, Dict[str, str], bytes, float], Tuple[int, Dict[str, str], bytes]]


def urllib_sender(ssl_cert_file: str = "") -> Send:
    ssl_ctx = make_ssl_context(ssl_cert_file)

    def send(url: str, headers: Dict[str, str], body: bytes, timeout: float) -> Tuple[int, Dict[str, str], bytes]:
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ssl_ctx) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers or {}), e.read()
        except (urllib.error.URLError, OSError) as e:
            reason = getattr(e, "reason", e)
            raise _Unreachable(isinstance(e, socket.timeout) or isinstance(reason, socket.timeout)) from None
    return send


def _daily_quota(raw: bytes) -> Optional[float]:
    """Seconds until the quota resets (0 when unknown) if this 429 says a per-day / per-month quota is used up,
    None for an ordinary per-minute rate limit (which waiting a little does cure)."""
    try:
        error = json.loads(raw).get("error") or {}
    except (ValueError, AttributeError):
        return None
    wait = 0.0
    violated = False
    for detail in error.get("details") or []:
        if not isinstance(detail, dict):
            continue
        for v in detail.get("violations") or []:
            metric = f"{v.get('quotaMetric', '')} {v.get('quotaId', '')}".lower()
            violated = violated or "perday" in metric.replace("_", "").replace("-", "") or "permonth" in metric.replace("_", "")
        delay = str(detail.get("retryDelay") or "")
        if delay.endswith("s"):
            try:
                wait = max(wait, float(delay[:-1]))
            except ValueError:
                pass
    return wait if violated or wait > LONG_WAIT else None


def _retry_after(headers: Dict[str, str]) -> Optional[float]:
    for key, value in headers.items():
        if key.lower() == "retry-after":
            try:
                return float(value)
            except (TypeError, ValueError):
                return None
    return None


class GeminiClient:
    def __init__(self, api_key: str, model: str, concurrency: int = 5, max_retries: int = 4,
                 base_delay: float = 1.0, timeout: float = 120.0, ssl_cert_file: str = "",
                 adaptive: bool = False, send: Optional[Send] = None):
        self.model = model[len("models/"):] if model.startswith("models/") else model
        self.limiter = AdaptiveLimiter(concurrency, adaptive=adaptive)
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.timeout = timeout
        self._url = ENDPOINT.format(model=self.model)
        # the key travels in a header, never in the URL (URLs end up in proxy logs)
        self._headers = {"Content-Type": "application/json", "x-goog-api-key": api_key}
        self._send = send or urllib_sender(ssl_cert_file)
        self._exhausted_until = 0.0

    def quota_exhausted(self) -> bool:
        """The API already said the quota is used up, and the time it gave has not passed."""
        return time.monotonic() < self._exhausted_until

    async def generate(self, image_b64: str, media_type: str, prompt: str, schema: Dict[str, Any],
                       system: Optional[str] = None, check: Optional[Callable[[Dict[str, Any]], None]] = None,
                       tag: str = "") -> Dict[str, Any]:
        """One image + prompt, answered as a JSON object that matches `schema`. `check` raises ValueError on a mismatch."""
        payload: Dict[str, Any] = {
            "contents": [{"role": "user", "parts": [
                {"inlineData": {"mimeType": media_type, "data": image_b64}},
                {"text": prompt},
            ]}],
            "generationConfig": {"responseMimeType": "application/json", "responseSchema": schema},
        }
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}
        body = json.dumps(payload).encode("utf-8")
        if self.quota_exhausted():  # no point asking: it would be refused, and every refusal is a wasted wait
            raise GeminiQuotaExhausted(self._exhausted_until - time.monotonic())

        attempt = 0
        while True:
            started = time.monotonic()
            try:
                await self.limiter.acquire()
                try:
                    status, headers, raw = await asyncio.to_thread(self._send, self._url, self._headers, body,
                                                                   self.timeout)
                finally:
                    await self.limiter.release()
                try:
                    out = self._interpret(status, headers, raw)
                except GeminiQuotaExhausted as e:
                    self._exhausted_until = time.monotonic() + (e.retry_in or QUOTA_BACKOFF)
                    log_event(log, "gemini_quota_exhausted", tag=tag, retry_in=int(e.retry_in or 0))
                    raise
                if check is not None:
                    try:
                        check(out)
                    except ValueError as e:
                        raise InvalidModelResponse(str(e)) from None
                self.limiter.on_success()
                log_event(log, "gemini_call", tag=tag, status=status, ms=int((time.monotonic() - started) * 1000))
                return out
            except ApiUnavailable:
                raise
            except (_Transient, _Unreachable, InvalidModelResponse) as e:
                if isinstance(e, _Transient) and e.status == 429:
                    self.limiter.on_rate_limit(e.retry_after)
                attempt += 1
                if attempt > self.max_retries:
                    if isinstance(e, _Unreachable) and not e.timed_out:
                        raise ApiUnavailable("unreachable") from None
                    if isinstance(e, _Transient):
                        raise GeminiError(str(e)) from None
                    if isinstance(e, _Unreachable):
                        raise GeminiError("timeout") from None
                    raise
                delay = self.base_delay * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
                log_event(log, "gemini_retry", tag=tag, attempt=attempt, error=type(e).__name__)
                await asyncio.sleep(delay)

    @staticmethod
    def _interpret(status: int, headers: Dict[str, str], raw: bytes) -> Dict[str, Any]:
        if status in (401, 403):
            log_event(log, "gemini_unavailable", status=status)
            raise ApiUnavailable("auth")
        if status == 429:
            quota = _daily_quota(raw)
            if quota is not None:
                raise GeminiQuotaExhausted(quota)
        if status in RETRY_STATUS:
            raise _Transient(status, _retry_after(headers))
        if status != 200:
            if status == 400 and b"API_KEY_INVALID" in raw:  # a wrong key is a 400 here, not a 401
                log_event(log, "gemini_unavailable", status=status)
                raise ApiUnavailable("auth")
            raise GeminiRequestRejected(f"http {status}")
        try:
            data = json.loads(raw)
        except ValueError:
            raise InvalidModelResponse("response is not JSON") from None
        if not isinstance(data, dict):
            raise InvalidModelResponse("response is not an object")
        block = (data.get("promptFeedback") or {}).get("blockReason")
        if block:
            raise InvalidModelResponse(f"blocked: {block}")
        candidates = data.get("candidates") or []
        if not candidates or not isinstance(candidates[0], dict):
            raise InvalidModelResponse("no candidates")
        finish = candidates[0].get("finishReason")
        if finish not in (None, "STOP"):
            raise InvalidModelResponse(f"finish reason {finish}")
        parts = (candidates[0].get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought"))
        try:
            out = json.loads(text)
        except ValueError:
            raise InvalidModelResponse("answer is not valid JSON") from None
        if not isinstance(out, dict):
            raise InvalidModelResponse("answer is not a JSON object")
        return out


# ---------- schema, prompts, parsing ----------

SYSTEM = (
    "You transcribe scanned Israeli medical commitment forms (טופס התחייבות) written in Hebrew. "
    "Forms mix printed text and handwriting (round script and print). The layout differs from form to form and "
    "has no fixed regions: find every field by its meaning and its label, never by its position on the page. "
    "Copy each value exactly as written, character by character, in its original script. "
    "Never correct, complete, translate, transliterate or guess. "
    "If a value is missing or cannot be read, return null for it with legible=false."
)

RULES = (
    "- value: exactly as written. Do not fix spelling, do not complete partial numbers, do not infer a value "
    "from another field.\n"
    "- id_number: the digits exactly as written. Do not apply or fix the check digit.\n"
    "- receipt_date: normalize to YYYY-MM-DD. If day and month are ambiguous, or the year is unclear, return the "
    "raw text as written and set legible=false.\n"
    "- central_numbers: every key number on the form as {label, value}; label is the caption written next to it, "
    "or null.\n"
    "- commitment_numbers: every commitment number, as a list of strings.\n"
    "- script: 'handwritten' if the value is written by hand, otherwise 'printed'.\n"
    "- legible: false if the value is hard to read or ambiguous, or if it is missing (then value is null).\n"
)

BOX_RULE = (
    "- box_2d: a tight box around the written value only (not its label) as [ymin, xmin, ymax, xmax], integers "
    "normalized to 0-1000 over the whole page; for a list field one box covering all of its values; null when the "
    "field is absent.\n"
)

PAGE_PROMPT = "Read the fields of this commitment form and answer as JSON matching the response schema.\n" + RULES + BOX_RULE

CROP_PROMPT = (
    "This image is a crop of a commitment form. Read only the field {name} and answer as JSON matching the "
    "response schema. The value may be handwritten, possibly faint.\n" + RULES
)


def _value_schema(name: str) -> Dict[str, Any]:
    if name == "central_numbers":
        item = {"type": "OBJECT", "properties": {"label": {"type": "STRING", "nullable": True},
                                                 "value": {"type": "STRING"}}, "required": ["label", "value"]}
        return {"type": "ARRAY", "nullable": True, "items": item}
    if name in MULTI_FIELDS:
        return {"type": "ARRAY", "nullable": True, "items": {"type": "STRING"}}
    return {"type": "STRING", "nullable": True}


def field_schema(name: str, with_box: bool) -> Dict[str, Any]:
    props: Dict[str, Any] = {
        "value": _value_schema(name),
        "script": {"type": "STRING", "enum": SCRIPTS},
        "legible": {"type": "BOOLEAN"},
    }
    if with_box:
        props["box_2d"] = {"type": "ARRAY", "nullable": True, "items": {"type": "INTEGER"},
                           "minItems": 4, "maxItems": 4}
    return {"type": "OBJECT", "description": FIELD_HINTS[name], "properties": props, "required": list(props)}


def page_schema() -> Dict[str, Any]:
    return {"type": "OBJECT", "properties": {n: field_schema(n, True) for n in FIELD_NAMES},
            "required": list(FIELD_NAMES)}


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def check_field(name: str, raw: Any, with_box: bool) -> None:
    """Raise ValueError (naming the field, never quoting a value) when `raw` does not match field_schema."""
    if not isinstance(raw, dict):
        raise ValueError(f"{name}: not an object")
    value = raw.get("value", ...)
    if value is ...:
        raise ValueError(f"{name}: no value key")
    if value is not None:
        if name == "central_numbers":
            ok = isinstance(value, list) and all(
                isinstance(i, dict) and isinstance(i.get("value"), str) and isinstance(i.get("label"), (str, type(None)))
                for i in value)
        elif name in MULTI_FIELDS:
            ok = isinstance(value, list) and all(isinstance(i, str) for i in value)
        else:
            ok = isinstance(value, str)
        if not ok:
            raise ValueError(f"{name}: value has the wrong type")
    if not isinstance(raw.get("legible"), bool):
        raise ValueError(f"{name}: legible is not a boolean")
    if raw.get("script") not in SCRIPTS:
        raise ValueError(f"{name}: script is not handwritten / printed")
    if with_box:
        box = raw.get("box_2d", ...)
        if box is ...:
            raise ValueError(f"{name}: no box_2d key")
        if box is not None and not (isinstance(box, list) and len(box) == 4 and all(_is_number(v) for v in box)):
            raise ValueError(f"{name}: box_2d is not four numbers")


def check_page(raw: Dict[str, Any]) -> None:
    for name in FIELD_NAMES:
        if name not in raw:
            raise ValueError(f"{name}: missing")
        check_field(name, raw[name], True)


def box_from_2d(box_2d: Optional[List[float]]) -> Optional[List[float]]:
    """Gemini's [ymin, xmin, ymax, xmax] on a 0-1000 scale -> the app's normalized [x0, y0, x1, y1]."""
    if not box_2d:
        return None
    ymin, xmin, ymax, xmax = box_2d
    return parse_box([xmin / 1000.0, ymin / 1000.0, xmax / 1000.0, ymax / 1000.0])


def _plain(name: str, value: Any) -> Any:
    if value is None:
        return None
    if name == "central_numbers":
        value = [i["value"] for i in value]
    if isinstance(value, list):
        value = [v.strip() for v in value if v.strip()]
        return value or None
    value = value.strip()
    return value or None


def to_field_result(name: str, raw: Dict[str, Any]) -> FieldResult:
    """A checked field object as the pipeline's FieldResult.

    Gemini gives no confidence score. The page read is trusted only through the independent second read, so
    confidence just mirrors legibility (1 or 0) and never claims more. A value the model itself marked as not
    legible (e.g. an ambiguous date, kept as raw text) is held for review with a reason that agreement of the
    two reads cannot clear. A null stays empty, as with the other provider.
    """
    value = _plain(name, raw["value"])
    legible = raw["legible"]
    box = box_from_2d(raw.get("box_2d"))
    reasons = [] if legible or value is None else [{"kind": "validation", "code": "illegible"}]
    return FieldResult(value=value, raw_value=value, confidence=1.0 if legible else 0.0, legible=legible,
                       handwritten=raw["script"] == "handwritten", box=box, hint_box=box, reasons=reasons)


class GeminiReader:
    tighten_boxes = False  # the page read's box is final: the zoomed second read is the verification
    recheck_all = True
    crop_margin = 0.0
    box_pad = 0.10
    reports_confidence = False  # to_field_result sets 1/0 from legibility: no real score
    check_reports_confidence = False

    def __init__(self, client: GeminiClient):
        self.client = client

    async def read_page(self, ctx: Context, image_path: str) -> Dict[str, FieldResult]:
        raw = await self.client.generate(
            encode_page(image_path), "image/jpeg", PAGE_PROMPT + _guide(FIELD_NAMES) + _senders(ctx, FIELD_NAMES) + lessons_of(ctx).prompt_for(FIELD_NAMES),
            page_schema(), system=SYSTEM, check=check_page, tag="extract")
        return {name: to_field_result(name, raw[name]) for name in FIELD_NAMES}

    async def read_crop(self, ctx: Context, image_b64: str, media_type: str, name: str) -> FieldResult:
        raw = await self.client.generate(
            image_b64, media_type, CROP_PROMPT.replace("{name}", name) + _guide([name]) + _senders(ctx, [name]) + lessons_of(ctx).prompt_for([name]),
            field_schema(name, False), system=SYSTEM, check=lambda r: check_field(name, r, False),
            tag=f"double_check:{name}")
        return to_field_result(name, raw)

    def same(self, name: str, a: Any, b: Any) -> bool:
        return same_reading(name, a, b)


def _senders(ctx: Context, names: List[str]) -> str:
    from pipeline.readers import sender_prompt  # readers builds this module's reader lazily: import it late

    return sender_prompt(ctx, names)


def _guide(names: List[str]) -> str:
    return "\nField guide (Hebrew):\n" + "\n".join(f"- {n}: {FIELD_HINTS[n]}" for n in names) + "\n"
