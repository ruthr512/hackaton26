"""Light read of a page that is not a commitment (referral, lab results, letter): who and what it is about.

Not a pipeline stage of its own: the runner calls it for `other_medical` pages (pipeline.yaml documents.read),
so they can be filed under the patient. One call, on the fast `document` model. Never fails the page.
"""
from typing import Any, Dict, Optional

from app.logging_utils import get_logger, log_event
from pipeline.base import Context, FormDoc
from pipeline.normalizers import clean_text, normalize_date, normalize_id, normalize_name
from pipeline.stages.extract import encode_page
from validators.israeli_id import is_valid_id

log = get_logger("document")

DOC_KINDS = ["referral", "lab_result", "letter", "other"]

SYSTEM = (
    "You index medical documents received by a virology lab in Israel (referrals, lab results, letters). "
    "Copy values exactly as written, in their original script; never translate names. "
    "Never infer or invent values: use null for anything not written on the page."
)

PROMPT = (
    "Record who this document is about and what it is, using the record_document tool: the patient's ID number "
    "(digits only) with your confidence between 0 and 1 that it is exactly right, the patient's full name, the "
    "document date as written, the kind of document, the requested test type (e.g. PCR, serology) if written, "
    "and the referral / order number if written. "
    "A document may show more than one date (e.g. the date it was issued and a receipt date, 'תאריך קבלה'). "
    "Tell them apart: if a receipt date is written, doc_date is the receipt date, not the issue date."
)

TOOL = {
    "name": "record_document",
    "description": "Record the identifying details of a medical document. Use null for anything not written.",
    "input_schema": {
        "type": "object",
        "properties": {
            "id_number": {"type": ["string", "null"]},
            "id_confidence": {"type": "number"},
            "full_name": {"type": ["string", "null"]},
            "doc_date": {"type": ["string", "null"]},
            "doc_kind": {"type": "string", "enum": DOC_KINDS},
            "test_type": {"type": ["string", "null"]},
            "referral_number": {"type": ["string", "null"]},
        },
        "required": ["id_number", "doc_kind"],
    },
}

ID_CONFIDENCE = 0.85


def _text(v: Any) -> Optional[str]:
    return clean_text(str(v)) or None if v not in (None, "") else None


def parse_document(got: Dict[str, Any]) -> Dict[str, Any]:
    id_number = normalize_id(str(got.get("id_number") or "")) or None
    try:
        conf = float(got.get("id_confidence") or 0.0)
    except (TypeError, ValueError):
        conf = 0.0
    kind = got.get("doc_kind") if got.get("doc_kind") in DOC_KINDS else "other"
    name = got.get("full_name")
    date = got.get("doc_date")
    return {
        "id_number": id_number,
        # filed automatically only when read with confidence AND the check digit holds; otherwise suggested
        "id_confident": bool(id_number and conf >= ID_CONFIDENCE and is_valid_id(id_number)),
        "full_name": normalize_name(str(name)) if name else None,
        "doc_date": normalize_date(str(date)) if date else None,
        "doc_kind": kind,
        "test_type": _text(got.get("test_type")),
        "referral_number": _text(got.get("referral_number")),
    }


async def read_document(doc: FormDoc, ctx: Context) -> None:
    """Fill doc.doc_meta. Any failure leaves the page as it was (kept, listed apart, no patient)."""
    if not doc.image_path:
        return
    try:
        got = await ctx.call_tool("document", image_b64=encode_page(doc.image_path), media_type="image/jpeg",
                                  prompt=PROMPT, tool=TOOL, system=SYSTEM)
        doc.doc_meta = parse_document(got or {})
    except Exception as e:  # never fail a page over its index card
        log_event(log, "document_read_failed", form_id=doc.form_id, error=type(e).__name__)
