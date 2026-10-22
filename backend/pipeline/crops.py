"""Zoomed crops of the full-resolution page image, for re-reading handwritten or faint fields.

The extract stage sends a downscaled full page; small pen writing loses detail there.
Crops are cut from the original page render (preprocess DPI) and upscaled.
"""
import base64
import io
from typing import List, Optional, Sequence, Tuple

from PIL import Image

MAX_UPSCALE = 4.0
MAX_EDGE = 1568  # the API downsizes anything larger anyway: sending more only costs upload time
MEDIA_TYPE = "image/jpeg"


def _encode(im: Image.Image) -> str:
    """JPEG (base64), long edge capped: a fraction of the PNG size, same detail for the model."""
    if max(im.size) > MAX_EDGE:
        im = im.copy()
        im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def pad_box(box: Sequence[float], ratio: float) -> List[float]:
    """The normalized box widened by `ratio` of its own width / height on every side, kept inside the page."""
    x0, y0, x1, y1 = box
    dx, dy = (x1 - x0) * ratio, (y1 - y0) * ratio
    return [max(0.0, x0 - dx), max(0.0, y0 - dy), min(1.0, x1 + dx), min(1.0, y1 + dy)]


def crop_region(image_path: str, box: Optional[Sequence[float]], margin: float = 0.03,
                min_width: int = 1000) -> Optional[Tuple[str, Tuple[float, float, float, float]]]:
    """(JPEG base64, normalized page rect [x0, y0, x1, y1] actually cut) of `box` widened by `margin`, or None."""
    if not box or len(box) != 4:
        return None
    x0, y0, x1, y1 = box
    with Image.open(image_path) as im:
        im = im.convert("RGB")
        w, h = im.size
        left = max(0, int((x0 - margin) * w))
        top = max(0, int((y0 - margin) * h))
        right = min(w, int((x1 + margin) * w))
        bottom = min(h, int((y1 + margin) * h))
        if right - left < 2 or bottom - top < 2:
            return None
        crop = im.crop((left, top, right, bottom))
    scale = min(MAX_UPSCALE, max(1.0, min_width / crop.width))
    if scale > 1.0:
        crop = crop.resize((round(crop.width * scale), round(crop.height * scale)), Image.LANCZOS)
    return _encode(crop), (left / w, top / h, right / w, bottom / h)


def crop_b64(image_path: str, box: Optional[Sequence[float]], margin: float = 0.03,
             min_width: int = 1000) -> Optional[str]:
    """JPEG (base64) of the normalized [x0, y0, x1, y1] box widened by `margin`, or None without a box."""
    cut = crop_region(image_path, box, margin, min_width)
    return cut[0] if cut else None


def halves_b64(image_path: str, overlap: float = 0.05) -> List[str]:
    """Top and bottom halves of the page at full resolution (slightly overlapping), for fields without a box."""
    with Image.open(image_path) as im:
        im = im.convert("RGB")
        w, h = im.size
        mid = h // 2
        pad = int(h * overlap)
        parts = [im.crop((0, 0, w, min(h, mid + pad))), im.crop((0, max(0, mid - pad), w, h))]
    return [_encode(p) for p in parts]
