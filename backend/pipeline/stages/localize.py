"""Stage 7 — localize: tighten and verify the frame drawn around every field.

The first read gives a coarse box from the downscaled page; models place those loosely, so frames
can spill over neighbouring text. Each box is re-located on a zoomed crop of the full-resolution page.
The tightened frame is used only if that second look reads the same value inside it (box_verified=True);
otherwise the coarse box is kept as the frame, flagged unverified so the UI draws it dashed.
"""
import asyncio
from typing import Any, List, Optional, Sequence

from app.logging_utils import get_logger, log_event
from pipeline.base import Context, FormDoc
from pipeline.crops import MEDIA_TYPE, crop_region
from pipeline.normalizers import normalize_field, values_equal
from pipeline.readers import reader_of
from pipeline.stages.extract import SYSTEM, build_tool, parse_box

log = get_logger("localize")

PROMPT = (
    "This image is a zoomed-in crop of a commitment form. Find the field {field} ({hint}). "
    "Return its value exactly as written, and box: the TIGHT bounding box around only the written value "
    "(not its printed label, not neighbouring fields or lines) as [x0, y0, x1, y1], fractions of THIS image "
    "between 0 and 1 measured from its top-left corner. Return value null and box null if it is not in this crop."
)

MAX_AREA = 0.9  # a box covering almost the whole crop did not localise anything


def to_page(box: Sequence[float], rect: Sequence[float]) -> List[float]:
    """Map a box in crop fractions to page fractions, given the crop's page rect."""
    cx0, cy0, cx1, cy1 = rect
    x0, y0, x1, y1 = box
    return [round(cx0 + x0 * (cx1 - cx0), 4), round(cy0 + y0 * (cy1 - cy0), 4),
            round(cx0 + x1 * (cx1 - cx0), 4), round(cy0 + y1 * (cy1 - cy0), 4)]


async def _locate(ctx: Context, form: FormDoc, name: str, margin: float) -> Optional[List[float]]:
    fr = form.fields[name]
    cut = crop_region(form.image_path, fr.hint_box, margin=margin)
    if cut is None:
        return None
    b64, rect = cut
    tool = build_tool([name])
    hint = tool["input_schema"]["properties"][name]["description"]
    got: Any = (await ctx.call_tool(
        "localize", image_b64=b64, media_type=MEDIA_TYPE, prompt=PROMPT.format(field=name, hint=hint),
        tool=tool, system=SYSTEM,
    )).get(name)
    if not isinstance(got, dict):
        return None
    value, _ = normalize_field(name, got.get("value"), ctx.senders_cfg)
    box = parse_box(got.get("box"))
    if value is None or box is None or not values_equal(value, fr.value):
        return None
    if (box[2] - box[0]) * (box[3] - box[1]) > MAX_AREA:
        return None
    return to_page(box, rect)


class Localize:
    async def run(self, form: FormDoc, ctx: Context) -> FormDoc:
        cfg = ctx.pipeline_cfg.get("localize", {})
        names = [n for n, fr in form.fields.items() if fr.value is not None and fr.hint_box]
        verified = {}
        if cfg.get("enabled", False) and reader_of(ctx).tighten_boxes:
            results = await asyncio.gather(
                *(_locate(ctx, form, n, float(cfg.get("margin", 0.06))) for n in names), return_exceptions=True)
            verified = dict(zip(names, results))
        for n, fr in form.fields.items():
            res = verified.get(n)
            if isinstance(res, Exception):
                log_event(log, "localize_failed", form_id=form.form_id, field=n, error=type(res).__name__)
                res = None
            fr.box_verified = res is not None
            fr.box = res if res is not None else fr.hint_box
            if n in verified and res is None:
                log_event(log, "box_unverified", form_id=form.form_id, field=n)
        return form
