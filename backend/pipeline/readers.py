"""The AI provider behind the two field reads (the whole page, and one zoomed crop).

The extract, localize and confidence stages talk to a `FieldReader`, never to a provider SDK, so the provider is a
configuration choice (pipeline.yaml: extract.provider = claude | gemini). ClaudeReader is the default and keeps
today's behaviour; its traits below are exactly what the stages did before readers existed.
"""
from typing import Any, Dict, Protocol

from app.fields import FIELD_NAMES
from pipeline.base import Context, FieldResult
from pipeline.learning import lessons_of
from pipeline.normalizers import values_equal
from pipeline.stages.extract import CALIBRATION, PROMPT, SENDER_LIST_PROMPT, SYSTEM, build_tool, encode_page, parse_field
from validators.senders import canonical_names

DOUBLE_CHECK_PROMPT = (
    "Look again, very carefully, only at these fields of the commitment form: {fields}. "
    "The image may be a zoomed-in crop of the form. The value may be handwritten, possibly faint, "
    "in Hebrew, English, Arabic or Russian. Read each value character by character and copy it "
    "in its original script. Return null if you are not certain."
)


def sender_prompt(ctx: Context, names: Any) -> str:
    """The closed sender list for the prompt of a read that includes the sender."""
    if "sender" not in names:
        return ""
    listed = canonical_names(ctx.senders_cfg or {})
    return SENDER_LIST_PROMPT.format(names="; ".join(listed)) if listed else ""


class ProviderConfigError(RuntimeError):
    """The configured provider cannot be used (unknown name, missing key or model)."""
    code = "provider_not_configured"


class FieldReader(Protocol):
    # How the stages treat this provider's reads
    tighten_boxes: bool  # localize re-locates every box on a zoomed crop (False: the page read's box is final)
    recheck_all: bool  # the independent second read covers every field with a value, not only the doubtful ones
    crop_margin: float  # margin of that crop around the box, as a fraction of the page
    box_pad: float  # ...and as a fraction of the box itself (applied first)
    reports_confidence: bool  # the page read gives a confidence of its own (False: it is a made-up constant)
    check_reports_confidence: bool  # ...and so does the independent second read

    async def read_page(self, ctx: Context, image_path: str) -> Dict[str, FieldResult]:
        """Every field of the page. A box, when given, is normalized [x0, y0, x1, y1] on the page."""

    async def read_crop(self, ctx: Context, image_b64: str, media_type: str, name: str) -> FieldResult:
        """One field, read on its own from an image (a crop, a page half or the page). Never sees an earlier answer."""

    def same(self, name: str, a: Any, b: Any) -> bool:
        """Whether two normalized reads of a field agree."""


class ClaudeReader:
    tighten_boxes = True
    recheck_all = False
    crop_margin = 0.03
    box_pad = 0.0
    reports_confidence = True
    check_reports_confidence = True

    async def read_page(self, ctx: Context, image_path: str) -> Dict[str, FieldResult]:
        result = await ctx.call_tool(
            "extract", image_b64=encode_page(image_path), media_type="image/jpeg",
            prompt=PROMPT + CALIBRATION + sender_prompt(ctx, FIELD_NAMES) + lessons_of(ctx).prompt_for(FIELD_NAMES),
            tool=build_tool(FIELD_NAMES), system=SYSTEM,
        )
        return {name: parse_field(result.get(name)) for name in FIELD_NAMES}

    async def read_crop(self, ctx: Context, image_b64: str, media_type: str, name: str) -> FieldResult:
        result = await ctx.call_tool(
            "double_check", image_b64=image_b64, media_type=media_type,
            prompt=DOUBLE_CHECK_PROMPT.format(fields=name) + CALIBRATION + sender_prompt(ctx, [name])
            + lessons_of(ctx).prompt_for([name]),
            tool=build_tool([name]), system=SYSTEM,
        )
        return parse_field(result.get(name))

    def same(self, name: str, a: Any, b: Any) -> bool:
        return values_equal(a, b)


_CLAUDE = ClaudeReader()


def reader_of(ctx: Context) -> FieldReader:
    """The reader chosen for this run (build_context puts it in ctx.extras); Claude when none was chosen."""
    return ctx.extras.get("reader") or _CLAUDE


class CrossCheckReader:
    """One model reads the page, a different one independently re-reads every value.

    Two models rarely misread the same character the same way, so their agreement is far stronger evidence than a
    single model's confidence, and a disagreement is the earliest sign of a wrong value.
    """
    recheck_all = True

    def __init__(self, primary: FieldReader, checker: FieldReader):
        self.primary, self.checker = primary, checker
        self.tighten_boxes = primary.tighten_boxes
        self.reports_confidence = primary.reports_confidence
        self.check_reports_confidence = checker.check_reports_confidence
        self.crop_margin = checker.crop_margin
        self.box_pad = checker.box_pad

    async def read_page(self, ctx: Context, image_path: str) -> Dict[str, FieldResult]:
        return await self.primary.read_page(ctx, image_path)

    async def read_crop(self, ctx: Context, image_b64: str, media_type: str, name: str) -> FieldResult:
        return await self.checker.read_crop(ctx, image_b64, media_type, name)

    def same(self, name: str, a: Any, b: Any) -> bool:
        return self.checker.same(name, a, b)


def _make_reader(provider: str, settings: Any, extract_cfg: Dict[str, Any], key: str) -> FieldReader:
    if provider == "claude":
        return _CLAUDE
    if provider == "gemini":
        from pipeline.gemini import GeminiClient, GeminiReader

        missing = [env for env, value in (("GEMINI_API_KEY", settings.gemini_api_key),
                                          ("GEMINI_MODEL", settings.gemini_model)) if not value]
        if missing:
            raise ProviderConfigError(f"extract.{key} is gemini but {', '.join(missing)} is not set")
        client = GeminiClient(
            api_key=settings.gemini_api_key, model=settings.gemini_model,
            ssl_cert_file=settings.ssl_cert_file,
            concurrency=extract_cfg.get("concurrency", 5),
            max_retries=extract_cfg.get("max_retries", 4),
            base_delay=extract_cfg.get("base_delay_seconds", 1.0),
            adaptive=bool(extract_cfg.get("adaptive", False)),
        )
        return GeminiReader(client)
    raise ProviderConfigError(f"unknown extract.{key}: {provider!r} (claude or gemini)")


def build_reader(settings: Any, extract_cfg: Dict[str, Any]) -> FieldReader:
    """The reader named by pipeline.yaml `extract.provider` (reads the page), cross-checked by `extract.verifier`.

    No verifier (or the same one): the provider re-reads its own page. Keys and models come from the environment only.
    """
    provider = str(extract_cfg.get("provider") or "claude").lower()
    verifier = str(extract_cfg.get("verifier") or provider).lower()
    primary = _make_reader(provider, settings, extract_cfg, "provider")
    if verifier == provider:
        return primary
    return CrossCheckReader(primary, _make_reader(verifier, settings, extract_cfg, "verifier"))
