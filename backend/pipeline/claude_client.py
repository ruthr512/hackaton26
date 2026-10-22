"""Thin async wrapper around the Claude API: forced tool use, adaptive concurrency limit, backoff, prompt caching."""
import asyncio
import os
import random
import ssl
import time
from typing import Any, Dict, List, Optional, Set

import anthropic

from app.logging_utils import get_logger, log_event

log = get_logger("claude")

RETRYABLE = (
    anthropic.RateLimitError,
    anthropic.APITimeoutError,
    anthropic.APIConnectionError,
    anthropic.InternalServerError,
)

TOOL_ONLY_INSTRUCTION = (
    "Return your result ONLY by calling the `{name}` tool, exactly once. "
    "Do not reply with plain text, explanations, or markdown."
)


class NoToolUseError(RuntimeError):
    """The model answered without calling the required tool (retried like a transient error)."""


class ApiUnavailable(RuntimeError):
    """The Claude API cannot serve any form right now (bad key, no credit, unreachable).

    Not worth retrying per form: the runner pauses the whole batch and tells the user once.
    """
    code = "api_unavailable"


# The API refuses every request until a human fixes something (key, permissions, billing)
FATAL = (anthropic.AuthenticationError, anthropic.PermissionDeniedError)
UNREACHABLE = (anthropic.APIConnectionError,)


def _is_billing_error(e: Exception) -> bool:
    if not isinstance(e, anthropic.BadRequestError):
        return False
    text = str(e).lower()
    return "credit" in text or "billing" in text


class AdaptiveLimiter:
    """A concurrency limit that backs off on rate limits and creeps back up after successes.

    With `adaptive=False` it behaves like a plain semaphore of `limit` (still honouring retry-after).
    """

    def __init__(self, limit: int, adaptive: bool = False, minimum: int = 2, grow_after: int = 10):
        self.maximum = max(1, limit)
        self.limit = self.maximum
        self.adaptive = adaptive
        self.minimum = min(minimum, self.maximum)
        self.grow_after = grow_after
        self.in_flight = 0
        self._ok_streak = 0
        self._cond: Optional[asyncio.Condition] = None
        self._paused_until = 0.0

    @property
    def cond(self) -> asyncio.Condition:
        # created lazily so it binds to the running event loop
        if self._cond is None:
            self._cond = asyncio.Condition()
        return self._cond

    async def acquire(self) -> None:
        async with self.cond:
            await self.cond.wait_for(lambda: self.in_flight < self.limit)
            self.in_flight += 1
        wait = self._paused_until - time.monotonic()
        if wait > 0:  # the API asked everyone to wait (retry-after)
            await asyncio.sleep(wait)

    async def release(self) -> None:
        async with self.cond:
            self.in_flight -= 1
            self.cond.notify_all()

    def on_success(self) -> None:
        if not self.adaptive or self.limit >= self.maximum:
            return
        self._ok_streak += 1
        if self._ok_streak >= self.grow_after:
            self._ok_streak = 0
            self.limit += 1

    def on_rate_limit(self, retry_after: Optional[float] = None) -> None:
        self._ok_streak = 0
        if retry_after:
            self._paused_until = max(self._paused_until, time.monotonic() + retry_after)
        if self.adaptive and self.limit > self.minimum:
            self.limit = max(self.minimum, self.limit // 2)
            log_event(log, "claude_concurrency_lowered", limit=self.limit)


def _retry_after(e: Exception) -> Optional[float]:
    try:
        value = e.response.headers.get("retry-after")  # type: ignore[attr-defined]
        return float(value) if value else None
    except (AttributeError, TypeError, ValueError):
        return None


def make_ssl_context(ssl_cert_file: str = "") -> ssl.SSLContext:
    """httpx alone trusts only certifi's bundle, which lacks the CA of a TLS-intercepting antivirus / filter.

    Trust the operating system's store (where that CA is installed) plus the optional SSL_CERT_FILE.
    """
    try:
        ssl_ctx = ssl.create_default_context()
    except OSError:
        # Some antivirus products set SSLKEYLOGFILE to a device Python may not open: that must not break every call.
        os.environ.pop("SSLKEYLOGFILE", None)
        ssl_ctx = ssl.create_default_context()
    if ssl_cert_file and os.path.isfile(ssl_cert_file):
        ssl_ctx.load_verify_locations(cafile=ssl_cert_file)
    return ssl_ctx


class ClaudeClient:
    def __init__(self, api_key: str, model: str, concurrency: int = 5,
                 max_retries: int = 4, base_delay: float = 1.0, max_tokens: int = 2048,
                 ssl_cert_file: str = "", adaptive: bool = False, cache: bool = True):
        ssl_ctx = make_ssl_context(ssl_cert_file)
        # The SDK's own client class: it subclasses whichever HTTP package the installed SDK uses
        # (httpx, or httpx2 in newer releases, which rejects a plain httpx.AsyncClient).
        http_client = anthropic.DefaultAsyncHttpxClient(verify=ssl_ctx, timeout=120.0)
        self._client = anthropic.AsyncAnthropic(api_key=api_key, max_retries=0, http_client=http_client)
        self.model = model
        self.limiter = AdaptiveLimiter(concurrency, adaptive=adaptive)
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.max_tokens = max_tokens
        self.cache = cache
        self._auto_only: Set[str] = set()  # models that reject a forced tool_choice

    async def call_tool(self, image_b64: str, media_type: str, prompt: str,
                        tool: Dict[str, Any], system: Optional[str] = None,
                        model: Optional[str] = None) -> Dict[str, Any]:
        """Send one page image + prompt, force `tool`, return the tool input dict."""
        content = [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}},
            {"type": "text", "text": prompt},
        ]
        return await self._call(content, tool, system, model)

    async def call_tool_text(self, prompt: str, tool: Dict[str, Any], system: Optional[str] = None,
                             model: Optional[str] = None) -> Dict[str, Any]:
        """Text only (no image), with the same forced tool use and retries."""
        return await self._call([{"type": "text", "text": prompt}], tool, system, model)

    async def _call(self, content: List[Dict[str, Any]], tool: Dict[str, Any], system: Optional[str],
                    model: Optional[str]) -> Dict[str, Any]:
        system_text = (f"{system}\n\n{TOOL_ONLY_INSTRUCTION.format(name=tool['name'])}"
                       if system else TOOL_ONLY_INSTRUCTION.format(name=tool["name"]))
        model = model or self.model
        kwargs: Dict[str, Any] = dict(
            model=model,
            max_tokens=self.max_tokens,
            # The tool schema and system prompt are identical on every call of a stage: let the API cache them.
            tools=[dict(tool, cache_control={"type": "ephemeral"}) if self.cache else tool],
            # Forcing the tool is much faster and never answers in prose, but some models reject it:
            # those get "auto" (the system prompt requires the tool; a reply without it is retried below).
            tool_choice=({"type": "auto"} if model in self._auto_only
                         else {"type": "tool", "name": tool["name"]}),
            messages=[{"role": "user", "content": content}],
            system=([{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}]
                    if self.cache else system_text),
        )

        attempt = 0
        while True:
            try:
                await self.limiter.acquire()
                try:
                    resp = await self._client.messages.create(**kwargs)
                finally:
                    await self.limiter.release()
                self.limiter.on_success()
                for block in resp.content:
                    if block.type == "tool_use" and block.name == tool["name"]:
                        return dict(block.input)
                raise NoToolUseError(f"model returned no {tool['name']} tool_use block")
            except FATAL as e:
                log_event(log, "claude_unavailable", error=type(e).__name__)
                raise ApiUnavailable(type(e).__name__) from e
            except anthropic.BadRequestError as e:
                if "tool_choice" in str(e) and kwargs["tool_choice"]["type"] != "auto":
                    self._auto_only.add(model)  # remembered: the next calls on this model go straight to "auto"
                    kwargs["tool_choice"] = {"type": "auto"}
                    log_event(log, "claude_tool_choice_auto", model=model)
                    continue
                if _is_billing_error(e):
                    log_event(log, "claude_unavailable", error="billing")
                    raise ApiUnavailable("billing") from e
                raise
            except RETRYABLE + (NoToolUseError,) as e:
                if isinstance(e, anthropic.RateLimitError):
                    self.limiter.on_rate_limit(_retry_after(e))
                attempt += 1
                if attempt > self.max_retries:
                    if isinstance(e, UNREACHABLE) and not isinstance(e, anthropic.APITimeoutError):
                        raise ApiUnavailable(type(e).__name__) from e
                    raise
                delay = self.base_delay * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
                log_event(log, "claude_retry", attempt=attempt, error=type(e).__name__)
                await asyncio.sleep(delay)
