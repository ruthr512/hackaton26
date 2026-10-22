"""Pure normalization functions, shared by the normalize stage, double-check and eval."""
import re
import unicodedata
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

from app.fields import MULTI_FIELDS
from validators.senders import resolve_sender, strip_department

_DATE_DMY = re.compile(r"^\s*(\d{1,2})\s*[/.\-\\]\s*(\d{1,2})\s*[/.\-\\]\s*(\d{2}|\d{4})\s*$")
_DATE_ISO = re.compile(r"^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$")
_SPLIT = re.compile(r"[,;\n\r\t ]+")
_EDGE_PUNCT = " .,;:-_|/\\\"'"
# Names keep a trailing apostrophe / geresh (ג'ורג') and inner hyphens.
_NAME_LEAD = _EDGE_PUNCT + "׳"
_NAME_TRAIL = " .,;:-_|/\\\""


def clean_text(v: str) -> str:
    return re.sub(r"\s+", " ", v).strip(_EDGE_PUNCT)


def normalize_name(v: str) -> str:
    v = re.sub(r"\s+", " ", unicodedata.normalize("NFC", v))
    return v.lstrip(_NAME_LEAD).rstrip(_NAME_TRAIL)


def normalize_id(v: str) -> str:
    """Digits only, without leading zeros (the check digit is validated on the 9-digit padded form)."""
    return re.sub(r"\D", "", v).lstrip("0")


def normalize_date(v: str) -> str:
    """Day-first dates (Israel) to ISO. Unparseable input is returned cleaned, for validate to flag."""
    m = _DATE_ISO.match(v)
    if m:
        y, mo, d = (int(x) for x in m.groups())
    else:
        m = _DATE_DMY.match(v)
        if not m:
            return clean_text(v)
        d, mo, y = (int(x) for x in m.groups())
        if y < 100:
            y += 2000
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return clean_text(v)


def normalize_multi(v: Any) -> List[str]:
    items = v if isinstance(v, list) else [v]
    out: List[str] = []
    for item in items:
        if item is None:
            continue
        for tok in _SPLIT.split(str(item)):
            tok = tok.strip(_EDGE_PUNCT)
            if tok and tok not in out:
                out.append(tok)
    return out


def normalize_field(name: str, value: Any, senders_cfg: Dict[str, Any]) -> Tuple[Any, List[Dict[str, str]]]:
    """Return (normalized value or None, reasons)."""
    reasons: List[Dict[str, str]] = []
    if value is None:
        return None, reasons
    if name in MULTI_FIELDS:
        out = normalize_multi(value)
        return (out or None), reasons
    if isinstance(value, list):
        value = " ".join(str(x) for x in value if x is not None)
    v = str(value)
    if name == "id_number":
        v = normalize_id(v)
    elif name == "full_name":
        v = normalize_name(v)
    elif name == "receipt_date":
        v = normalize_date(v)
    elif name == "sender":
        v = clean_text(v)
        canonical, _score, how = resolve_sender(v, senders_cfg)
        if canonical:
            if how == "fuzzy":
                reasons.append({"kind": "soft", "code": "sender_fuzzy_match"})
            elif how == "words" and v != canonical:
                reasons.append({"kind": "info", "code": "sender_resolved"})
            v = canonical
        else:
            v = clean_text(strip_department(v))  # an unknown hospital's department: the hospital is the sender
    else:
        v = clean_text(v)
    return (v or None), reasons


def _fold(v: Any) -> Any:
    return unicodedata.normalize("NFC", v).casefold() if isinstance(v, str) else v


def values_equal(a: Any, b: Any) -> bool:
    """Equal after Unicode NFC and case folding (Latin/Cyrillic case differences are not a disagreement)."""
    if isinstance(a, list) or isinstance(b, list):
        return sorted(_fold(x) for x in a or []) == sorted(_fold(x) for x in b or [])
    return _fold(a or None) == _fold(b or None)


_NUMBER_NOISE = re.compile(r"[\s\-‐-―־]+")  # spaces, hyphens, dashes, maqaf


def _bare_number(v: Any) -> Any:
    if isinstance(v, list):
        return [_bare_number(x) for x in v]
    return (_NUMBER_NOISE.sub("", v) or None) if isinstance(v, str) else v


def same_reading(name: str, a: Any, b: Any) -> bool:
    """Two reads of one field agree. IDs and numbers also ignore spaces and hyphens; other fields: values_equal."""
    if name == "id_number" or name in MULTI_FIELDS:
        return values_equal(_bare_number(a), _bare_number(b))
    return values_equal(a, b)


def to_display_date(iso: Optional[str], fmt: str = "DD/MM/YYYY") -> Optional[str]:
    if not iso:
        return iso
    try:
        d = date.fromisoformat(iso)
    except ValueError:
        return iso
    return fmt.replace("DD", f"{d.day:02d}").replace("MM", f"{d.month:02d}").replace("YYYY", f"{d.year:04d}")
