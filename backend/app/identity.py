"""Identity cross-check of commitments against the patients already in the system.

An ID number can only belong to one person, so once it is read with confidence it says who the form is about:
- the name is unsure / empty / garbled: it is taken to be the name already filed under that ID;
- the name is read clearly but is another name than the one filed: one of them is wrong, so both fields are flagged.
Names are compared only within the same script (Hebrew / Latin / Arabic / Cyrillic): "דנה כהן" and "Dana Cohen"
may well be one person, and there is no telling them apart here.

It runs when a form is read (`reconcile`, on the fields just read) and again whenever a person fixes or approves
a name or an ID (`propagate`, on the stored fields): forms of one file are read together, long before anyone has
confirmed the name, so the confirmed name must reach the other forms of the same ID afterwards.
A field a person has touched is never changed here.

A clear name that differs from the one filed under a trusted ID is a possible NAME CHANGE, however sure the read is:
the clerk is told on the name field. Approving it makes the new name the patient's name (`confirm_name`: a
`PatientName` row; the earlier forms keep the name they were read with); until she does, the form cannot be
approved for export (`open_name_change`).
"""
import json
import unicodedata
from collections import Counter
from datetime import datetime
from typing import Any, Dict, List, Optional

from rapidfuzz import fuzz
from sqlmodel import Session, select

from app import audit
from app.config import get_settings
from app.fields import LEVEL_EMPTY, LEVEL_OK, LEVEL_REVIEW, OPTIONAL_FIELDS
from app.models import Field, Form, PatientName, User
from app.patients import FILED, LINK_SUGGESTED, patient_key
from app.workflow import APPROVED, NEEDS_FIX, PENDING_APPROVAL, initial_workflow
from pipeline.base import FieldResult, FormDoc
from pipeline.normalizers import normalize_name
from validators.israeli_id import is_valid_id

DEFAULT_ID_MIN_CONFIDENCE = 0.70  # the ID is trusted to identify the person above this
DEFAULT_NAME_MIN_CONFIDENCE = 0.65  # a name read with less than this is not trusted over the patient file
DEFAULT_NAME_MATCH = 75  # similarity (0-100) from which two names count as the same person
NAME_FROM_PATIENT = "name_from_patient_file"
CONFLICT = "id_name_conflict"  # on the ID field: this ID is filed under another name
NAME_CHANGE = "name_change"  # on the name field: carries the filed name as `detail`
DEFAULT_REVIEW_BELOW = 0.80
DEFAULT_EMPTY_BELOW = 0.50  # under this the confidence stage empties a field: nothing was read


def script_of(name: str) -> Optional[str]:
    """The script most of the letters of a name are written in, or None when it has no letters."""
    counts: Counter = Counter()
    for ch in name:
        if ch.isalpha():
            label = unicodedata.name(ch, "")
            counts[next((s for s in ("HEBREW", "ARABIC", "CYRILLIC", "LATIN") if label.startswith(s)), "OTHER")] += 1
    return counts.most_common(1)[0][0] if counts else None


def same_person(a: str, b: str, min_score: float) -> bool:
    a, b = normalize_name(a).casefold(), normalize_name(b).casefold()
    return a == b or fuzz.token_sort_ratio(a, b) >= min_score


def _touched(fld: Field) -> bool:
    """A person already corrected or approved this field."""
    return bool(fld.manually_corrected) or (fld.version or 0) != 0


def known_names(s: Session, key: str, exclude_form_id: Optional[int]) -> List[str]:
    """Names filed under this ID by other commitments, most common first.

    A name a person confirmed (corrected / approved field, or approved form) is the truth and wins; failing that,
    names read with confidence. A doubtful read never counts as "what the system knows".
    A name the clerk approved as the patient's new name (PatientName) beats all of them.
    """
    renamed = s.get(PatientName, key)
    if renamed is not None:
        return [renamed.full_name]
    rows = s.exec(
        select(Field, Form).join(Form, Field.form_id == Form.id).where(
            Field.name == "full_name", Form.status == "done", Form.parent_form_id == None,  # noqa: E711
            Form.doc_type == "commitment", Form.patient_id == key, Form.patient_link.in_(list(FILED)))
    ).all()
    confirmed, confident = Counter(), Counter()
    for fld, form in rows:
        name = json.loads(fld.value) if fld.value else None
        if form.id == exclude_form_id or not isinstance(name, str) or not name.strip():
            continue
        if _touched(fld) or form.workflow == APPROVED:
            confirmed[name] += 1
        elif fld.level == LEVEL_OK:
            confident[name] += 1
    return [n for n, _ in (confirmed or confident).most_common()]


def _id_trusted(ident: FieldResult, cfg: Dict[str, Any], confirmed_by_person: bool = False) -> Optional[str]:
    """The patient key when this ID can be relied on to identify the person, else None.

    Trusted: a valid check digit, and either a person confirmed it, or it was read clearly, or two reads agreed.
    """
    key = patient_key(ident.value)
    if key is None or not is_valid_id(key) or any(
            r["kind"] in ("validation", "double_check") and r["code"] != CONFLICT for r in ident.reasons):
        return None
    if confirmed_by_person:
        return key
    two_reads = any(r["code"] == "double_check_confirmed" for r in ident.reasons)
    id_min = float(cfg.get("id_min_confidence", DEFAULT_ID_MIN_CONFIDENCE))
    return key if two_reads or (ident.legible and ident.confidence >= id_min) else None


def _drop_conflict(fr: FieldResult, cfg: Dict[str, Any]) -> None:
    """Take back an earlier conflict flag that no longer applies (the filed name changed, or the ID was fixed)."""
    kept = [r for r in fr.reasons if r["code"] not in (CONFLICT, NAME_CHANGE)]
    if len(kept) == len(fr.reasons):
        return
    fr.reasons = kept
    review_below = float((cfg.get("confidence") or {}).get("review_below", DEFAULT_REVIEW_BELOW))
    if not kept and fr.level == LEVEL_REVIEW and fr.value is not None and fr.confidence >= review_below:
        fr.level = LEVEL_OK  # nothing else made it doubtful


def _decide(name: FieldResult, ident: FieldResult, names: List[str], pipeline_cfg: Dict[str, Any]) -> None:
    """The two rules, on a name and an ID already known to belong together. Mutates the results.

    - the name is missing, unreadable, or so doubtful that the confidence stage drops it: it is the filed name;
    - it is the filed name in other words (spelling, order, a doubtful read of it): the filed name is kept;
    - it is another name, however sure the read is (even a doubtful one that is still shown): a possible name
      change. It is never swapped for the filed name behind the clerk's back, she is asked (NAME_CHANGE).
    """
    for fr in (name, ident):
        _drop_conflict(fr, pipeline_cfg)
    identity_cfg = pipeline_cfg.get("identity") or {}
    threshold = float(identity_cfg.get("name_min_confidence", DEFAULT_NAME_MIN_CONFIDENCE))
    dropped_below = float((pipeline_cfg.get("confidence") or {}).get("empty_below", DEFAULT_EMPTY_BELOW))
    if name.value is None or not name.legible or name.confidence < dropped_below:
        _take_filed_name(name, names[0])
        return
    min_score = float(identity_cfg.get("name_match", DEFAULT_NAME_MATCH))
    script = script_of(str(name.value))
    comparable = [n for n in names if script_of(n) == script]
    if not comparable:  # another script: no telling them apart, so only a doubtful read gives way to the filed name
        if name.confidence < threshold:
            _take_filed_name(name, names[0])
        return
    same = next((n for n in comparable if same_person(str(name.value), n, min_score)), None)
    if same is not None:
        if name.confidence < threshold:
            _take_filed_name(name, same)
        return
    name.add_reason("validation", NAME_CHANGE, detail=comparable[0])
    ident.add_reason("validation", CONFLICT)
    for fr in (name, ident):
        fr.level = LEVEL_REVIEW


def open_name_change(s: Session, form_id: int) -> Optional[str]:
    """The filed name this form's name would replace, while the clerk has not yet decided; else None."""
    fld = s.exec(select(Field).where(Field.form_id == form_id, Field.name == "full_name")).first()
    if fld is None or fld.level != LEVEL_REVIEW:
        return None
    return next((r.get("detail") or "" for r in json.loads(fld.reasons or "[]") if r["code"] == NAME_CHANGE), None)


def confirm_name(s: Session, user: Optional[User], fld: Field, pipeline_cfg: Optional[Dict[str, Any]] = None) -> bool:
    """A person approved / typed the name of a form flagged as a name change: the patient file takes that name.

    Typing back the name that is filed (same person) is the clerk saying the new read was wrong: nothing changes.
    The caller commits. True when the patient's name changed.
    """
    reason = next((r for r in json.loads(fld.reasons or "[]") if r["code"] == NAME_CHANGE), None)
    form = s.get(Form, fld.form_id)
    value = json.loads(fld.value) if fld.value else None
    if reason is None or form is None or form.patient_id is None or not isinstance(value, str) or not value.strip():
        return False
    old = reason.get("detail") or ""
    min_score = float(((pipeline_cfg or {}).get("identity") or {}).get("name_match", DEFAULT_NAME_MATCH))
    if same_person(value, old, min_score):
        return False
    row = s.get(PatientName, form.patient_id)
    previous = json.loads(row.previous_names) if row else []
    if old and old not in previous:
        previous.append(old)
    row = row or PatientName(patient_id=form.patient_id, full_name=value)
    row.full_name, row.previous_names = value, json.dumps(previous, ensure_ascii=False)
    row.changed_at, row.changed_by = datetime.utcnow(), user.id if user else None
    s.add(row)
    audit.record(s, user, "patient_renamed", "patient", 0, form_id=form.id,
                 before={"patient_id": form.patient_id, "name": old}, after={"patient_id": form.patient_id, "name": value})
    return True


def _take_filed_name(name: FieldResult, filed: str) -> None:
    """The ID is known, the name read here is not reliable: it is the name filed under that ID."""
    if name.value is not None and name.raw_value is None:
        name.raw_value = name.value
    name.value = filed
    # What made the read unsure no longer matters; a lab rule (validation) still does.
    name.reasons = [r for r in name.reasons if r["kind"] == "validation" and r["code"] not in (CONFLICT, NAME_CHANGE)]
    name.add_reason("info", NAME_FROM_PATIENT)
    name.level = LEVEL_REVIEW if any(r["kind"] == "validation" for r in name.reasons) else LEVEL_OK


# ---------- on a freshly read form ----------

def reconcile(s: Session, doc: FormDoc, form_id: Optional[int], pipeline_cfg: Optional[Dict[str, Any]] = None) -> None:
    """Apply the identity rules to the fields of a freshly read form (in place). Idempotent."""
    pipeline_cfg = pipeline_cfg or {}
    ident, name = doc.fields.get("id_number"), doc.fields.get("full_name")
    if doc.doc_type != "commitment" or ident is None or name is None or ident.value is None:
        return
    key = _id_trusted(ident, pipeline_cfg.get("identity") or {})
    names = known_names(s, key, form_id) if key else []
    if names:
        _decide(name, ident, names, pipeline_cfg)


# ---------- on stored forms, after a person's edit ----------

def _result(fld: Field) -> FieldResult:
    reasons = json.loads(fld.reasons or "[]")
    codes = {r["code"] for r in reasons}
    return FieldResult(
        value=json.loads(fld.value) if fld.value else None,
        raw_value=json.loads(fld.raw_value) if fld.raw_value else None,
        confidence=fld.confidence, legible="illegible" not in codes, handwritten="handwritten" in codes,
        level=fld.level, reasons=reasons)


def _store(fld: Field, fr: FieldResult) -> bool:
    """Write a changed result back to its row (without bumping `version`: that marks a person's edit)."""
    value = None if fr.value is None else json.dumps(fr.value, ensure_ascii=False)
    reasons = json.dumps(fr.reasons, ensure_ascii=False)
    if (value, reasons, fr.level) == (fld.value, fld.reasons, fld.level):
        return False
    fld.value, fld.reasons, fld.level = value, reasons, fr.level
    if fld.raw_value is None and fr.raw_value is not None:
        fld.raw_value = json.dumps(fr.raw_value, ensure_ascii=False)
    return True


def _reconcile_form(s: Session, form: Form, rows: Dict[str, Field], pipeline_cfg: Dict[str, Any]) -> bool:
    """Apply the rules to one stored form. True when it changed."""
    name_row, id_row = rows.get("full_name"), rows.get("id_number")
    if name_row is None or id_row is None or id_row.value is None or _touched(name_row):
        return False  # a person's name is the truth
    name, ident = _result(name_row), _result(id_row)
    key = _id_trusted(ident, pipeline_cfg.get("identity") or {}, confirmed_by_person=_touched(id_row))
    names = known_names(s, key, form.id) if key else []
    before = {"value": name.value, "level": name.level}
    if names:
        _decide(name, ident, names, pipeline_cfg)
    else:  # e.g. the ID was fixed: a flag raised against the old ID no longer stands
        for fr in (name, ident):
            _drop_conflict(fr, pipeline_cfg)
    changed = _store(name_row, name)
    changed = _store(id_row, ident) or changed
    if changed:
        s.add(name_row)
        s.add(id_row)
        audit.record(s, None, "identity_applied", "field", name_row.id, form_id=form.id, before=before,
                     after={"value": name.value, "level": name.level})
    return changed


def _restart_workflow(s: Session, form: Form, rows: Dict[str, Field]) -> None:
    """A form still waiting for the clerk whose every field is now ok skips the clerk, as when it is read.

    The other way round: a form already handed to the approver whose name has just been flagged as a name change
    goes back to the clerk, who is the one to decide on it.
    """
    name_row = rows.get("full_name")
    if (form.workflow == PENDING_APPROVAL and name_row is not None and name_row.level == LEVEL_REVIEW
            and any(r["code"] == NAME_CHANGE for r in json.loads(name_row.reasons or "[]"))):
        audit.record(s, None, "status_change", "form", form.id, before={"workflow": form.workflow},
                     after={"workflow": NEEDS_FIX})
        form.workflow = NEEDS_FIX
        s.add(form)
        return
    if form.workflow != NEEDS_FIX or any(_touched(f) for f in rows.values()):
        return
    levels = [f.level for f in rows.values() if not (f.name in OPTIONAL_FIELDS and f.level == LEVEL_EMPTY)]
    new = initial_workflow(levels, json.loads(form.reasons or "[]"))
    if new != form.workflow:
        audit.record(s, None, "status_change", "form", form.id, before={"workflow": form.workflow},
                     after={"workflow": new})
        form.workflow = new
        s.add(form)


def propagate(s: Session, form: Form) -> None:
    """A person fixed or approved a name / ID on `form`: bring it and the not yet approved forms of the same ID in line.

    Commits (it is called once the person's own edit is saved) and tells live screens.
    """
    from app import events

    if form is None or form.patient_id is None or form.doc_type != "commitment":
        return
    pipeline_cfg = get_settings().pipeline
    forms = s.exec(select(Form).where(
        Form.status == "done", Form.parent_form_id == None, Form.doc_type == "commitment",  # noqa: E711
        Form.patient_id == form.patient_id, Form.patient_link.in_([*FILED, LINK_SUGGESTED]),
        Form.workflow != APPROVED)).all()
    changed = set()
    for fm in forms:
        rows = {f.name: f for f in s.exec(select(Field).where(Field.form_id == fm.id)).all()}
        if _reconcile_form(s, fm, rows, pipeline_cfg):
            _restart_workflow(s, fm, rows)
            changed.add(fm.batch_id)
    if changed:
        s.commit()
        for batch_id in changed:
            events.bump(batch_id)
