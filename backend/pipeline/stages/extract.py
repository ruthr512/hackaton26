"""Stage 5 — extract: read the fields from the page image with Claude tool use.

Only the page image is sent. Values may be printed or handwritten, in any language.
Unclear but present values come back as a best reading flagged legible=false (-> review);
null is kept for values that are absent or cannot be read at all.
"""
import base64
import io
from typing import Any, Dict, Iterable, List, Optional

from PIL import Image

from app.fields import MULTI_FIELDS
from pipeline.base import Context, FieldResult, FormDoc

MAX_EDGE = 1568  # Claude's recommended long edge; keeps payloads small

FIELD_HINTS = {
    "full_name": "שם מלא של המטופל/ת (פרטי + משפחה) כפי שכתוב — מודפס או בכתב יד, בכל שפה",
    "id_number": "מספר תעודת זהות של המטופל/ת (ספרות בלבד) — מודפס או בכתב יד",
    "central_numbers": "מספרים מרכזיים (מספרי דגימה/מעבדה) — כל המספרים שמופיעים",
    "receipt_date": (
        "תאריך קבלה (התאריך שבו הדגימה/הטופס התקבלו במעבדה), בדיוק כפי שכתוב בטופס. "
        "אם מופיעים בטופס גם תאריך אחר (תאריך הטופס, תאריך הפניה, תאריך הוצאה, תאריך דגימה, תאריך הדפסה) "
        "וגם 'תאריך קבלה' — קח רק את תאריך הקבלה; אל תחליף אותו בתאריך האחר. "
        "אם אין תאריך קבלה מפורש, החזר null"
    ),
    "sender": (
        "הגורם המפנה: קופת החולים או בית החולים (המוסד, לא המחלקה). אם כתובה מחלקה או מרפאה של מוסד "
        "(למשל 'מחלקת פנימית ב' לניאדו') — החזר את שם המוסד ('לניאדו'), לא את שם המחלקה. "
        "העתק את שם המוסד כפי שכתוב; אל תמציא שם שלא מופיע בטופס"
    ),
    "commitment_numbers": "מספרי התחייבות — כל המספרים שמופיעים",
    "test_type": "סוג הבדיקה המבוקשת (למשל PCR, סרולוגיה, תרבית) כפי שכתוב או מסומן בטופס; null אם לא מופיע",
    "referral_number": "מספר הפניה / מספר הזמנה, אם מופיע בטופס (לא מספר התחייבות); null אם לא מופיע",
}

SCRIPTS = ["hebrew", "latin", "arabic", "cyrillic", "digits", "mixed"]

SYSTEM = (
    "You transcribe lab commitment forms (טופס התחייבות) for a virology lab in Israel. "
    "Forms mix printed text and handwriting (pen, often faint or written over printed text). "
    "Handwriting may be in Hebrew, English, Arabic or Russian, or another language. "
    "Copy values exactly as written, in their original script: never translate or transliterate names. "
    "Accuracy matters more than completeness, and every value you return is shown to a human for checking: "
    "when something is written but hard to read, return your best reading with legible=false and a low confidence. "
    "Return null only when the value is absent, crossed out, cut off, or cannot be read at all. "
    "Never infer or invent values, and never copy a value from a different field."
)

SENDER_LIST_PROMPT = (
    "\nKnown senders (hospitals and health funds): {names}. "
    "For the sender field: if the form names one of these (or a department / clinic of one), return that sender's "
    "name exactly as listed. If the sender is a hospital or fund that is NOT in this list, return the institution's "
    "name as written on the form (without the department), never the closest listed name."
)

PROMPT = (
    "Extract the fields from this commitment form using the record_form tool. "
    "Read handwritten values as carefully as printed ones; a handwritten value may override a printed placeholder. "
    "For each field give value (or null), confidence between 0 and 1 that the value is exactly right, "
    "legible=false if the handwriting or print is hard to read, handwritten=true if the value is handwritten, "
    "and script: the writing system of the value. "
    "central_numbers and commitment_numbers are lists: include every number you see for them. "
    "Also give box: the tight bounding box around the written value (not its printed label) as "
    "[x0, y0, x1, y1], fractions of the page width/height between 0 and 1, measured from the top-left corner. "
    "Give box even when value is null but something is written there, so it can be re-read zoomed in. "
    "For a list field, one box that covers all of its numbers."
)

# Models say "1.0" for almost everything unless told what the number means; the pipeline re-reads and cross-checks
# every value anyway, so an honest low score costs nothing and an inflated one hides errors.
CALIBRATION = (
    "\nConfidence is a probability, not a feeling: of 100 values you rate 0.9, about 90 must be exactly right. "
    "Use 0.95-1.0 only for crisp printed text where every character is unambiguous. "
    "Handwriting is rarely above 0.85. If any character could be read two ways (1/7, 0/6, 4/9, ר/ד, ו/ז, a/o) "
    "stay at 0.6 or less. A value you partly guessed, or read from a faint or cut-off area, is 0.4 or less. "
    "If you would not bet on the value, return null instead of a guess."
)


def build_tool(fields: Iterable[str]) -> Dict[str, Any]:
    props = {}
    for name in fields:
        if name in MULTI_FIELDS:
            value_schema = {"type": ["array", "null"], "items": {"type": "string"}}
        else:
            value_schema = {"type": ["string", "null"]}
        props[name] = {
            "type": "object",
            "description": FIELD_HINTS[name],
            "properties": {
                "value": value_schema,
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "legible": {"type": "boolean"},
                "handwritten": {"type": "boolean"},
                "script": {"type": ["string", "null"], "enum": SCRIPTS + [None]},
                "box": {
                    "type": ["array", "null"],
                    "items": {"type": "number", "minimum": 0, "maximum": 1},
                    "minItems": 4,
                    "maxItems": 4,
                    "description": "[x0, y0, x1, y1] of the value on the page, as fractions from the top-left",
                },
            },
            "required": ["value", "confidence", "legible"],
        }
    return {
        "name": "record_form",
        "description": "Record the fields read from the form. Use null only for values that are absent or unreadable.",
        "input_schema": {"type": "object", "properties": props, "required": list(props)},
    }


def encode_page(image_path: str) -> str:
    with Image.open(image_path) as im:
        im = im.convert("RGB")
        im.thumbnail((MAX_EDGE, MAX_EDGE))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def parse_box(raw: Any) -> Optional[List[float]]:
    """A usable normalized [x0, y0, x1, y1] box, or None. The model's coordinates are only a display aid."""
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    try:
        x0, y0, x1, y1 = (min(max(float(v), 0.0), 1.0) for v in raw)
    except (TypeError, ValueError):
        return None
    if x1 - x0 < 0.005 or y1 - y0 < 0.003:
        return None
    return [round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4)]


def parse_field(raw: Any) -> FieldResult:
    if not isinstance(raw, dict):
        return FieldResult(value=None, raw_value=None, confidence=0.0, legible=False)
    value = raw.get("value")
    if isinstance(value, str) and not value.strip():
        value = None
    if isinstance(value, list) and not value:
        value = None
    try:
        conf = float(raw.get("confidence", 0.0))
    except (TypeError, ValueError):
        conf = 0.0
    box = parse_box(raw.get("box"))
    return FieldResult(value=value, raw_value=value, confidence=max(0.0, min(conf, 1.0)),
                       legible=bool(raw.get("legible", True)),
                       handwritten=bool(raw.get("handwritten", False)),
                       box=box, hint_box=box)


class Extract:
    async def run(self, form: FormDoc, ctx: Context) -> FormDoc:
        from pipeline.readers import reader_of  # readers imports this module's prompts and helpers

        form.fields = await reader_of(ctx).read_page(ctx, form.image_path)
        return form
