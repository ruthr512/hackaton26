"""Patient file: every commitment and referral filed under one ID number.

Viewing a patient's file is itself audited (identifying medical data).
"""
import json
import re
from collections import defaultdict
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app import audit, events
from app.api.serialize import load_value
from app.auth import ROLE_ADMIN, ROLE_APPROVER, ROLE_INTAKE, ROLE_MANAGER, require_roles
from app.db import get_session
from app.models import Field, Form, PatientName, SourceFile, User
from app.patients import FILED, LINK_MANUAL, LINK_REJECTED, LINK_SUGGESTED, patient_key
from pipeline.normalizers import normalize_name

ALL_STAFF = (ROLE_INTAKE, ROLE_APPROVER, ROLE_MANAGER, ROLE_ADMIN)
router = APIRouter(prefix="/api", tags=["patients"], dependencies=[Depends(require_roles(*ALL_STAFF))])

SEARCH_LIMIT = 50
KEY_FIELDS = ("full_name", "id_number", "receipt_date", "sender", "commitment_numbers", "test_type",
              "referral_number")


class LinkBody(BaseModel):
    action: str  # confirm | reject | set
    patient_id: Optional[str] = None


def _linked_forms(s: Session, pid: Optional[str] = None, links=FILED) -> List[Form]:
    q = select(Form).where(Form.status == "done", Form.parent_form_id == None,  # noqa: E711
                           Form.patient_id != None, Form.patient_link.in_(list(links)))  # noqa: E711
    if pid is not None:
        q = q.where(Form.patient_id == pid)
    return s.exec(q.order_by(Form.created_at)).all()


def _field_values(s: Session, form_ids: List[int]) -> Dict[int, Dict[str, Any]]:
    out: Dict[int, Dict[str, Any]] = {i: {} for i in form_ids}
    if form_ids:
        for fld in s.exec(select(Field).where(Field.form_id.in_(form_ids), Field.name.in_(KEY_FIELDS))).all():
            out[fld.form_id][fld.name] = load_value(fld.value)
    return out


def _name_of(fm: Form, values: Dict[str, Any]) -> Optional[str]:
    if fm.doc_type == "commitment":
        return values.get("full_name")
    return (load_value(fm.doc_meta) or {}).get("full_name")


def _matches(needle: str, fm: Form, values: Dict[str, Any]) -> bool:
    digits = re.sub(r"\D", "", needle)
    if digits and digits == needle.replace(" ", "").replace("-", ""):
        key = patient_key(digits)
        numbers = values.get("commitment_numbers") or []
        return fm.patient_id == key or any(str(n) == digits for n in numbers) or digits in (fm.patient_id or "")
    name = _name_of(fm, values)
    return bool(name) and normalize_name(needle).casefold() in normalize_name(str(name)).casefold()


@router.get("/patients")
def search(q: str = "", s: Session = Depends(get_session)):
    """Patients matching an ID, a (partial) name in any script, or a commitment number."""
    needle = q.strip()
    forms = _linked_forms(s)
    values = _field_values(s, [f.id for f in forms])
    groups: Dict[str, List[Form]] = defaultdict(list)
    for fm in forms:
        groups[fm.patient_id].append(fm)
    out = []
    for pid, fms in groups.items():
        if needle and not any(_matches(needle, fm, values[fm.id]) for fm in fms):
            continue
        names = list(dict.fromkeys(n for n in (_name_of(fm, values[fm.id]) for fm in fms) if n))
        rename = _rename_of(s, pid)
        out.append({
            "patient_id": pid,
            "names": _names_for(rename, names),
            "name_changed": rename is not None,
            "commitments": sum(1 for fm in fms if fm.doc_type == "commitment"),
            "documents": sum(1 for fm in fms if fm.doc_type != "commitment"),
            "last_seen": max(fm.created_at for fm in fms).isoformat(),
        })
    out.sort(key=lambda r: r["last_seen"], reverse=True)
    return out[:SEARCH_LIMIT]


def _rename_of(s: Session, pid: str) -> Optional[Dict[str, Any]]:
    """Set when a clerk approved a new name for this patient: older documents may still carry the old one."""
    row = s.get(PatientName, pid)
    if row is None:
        return None
    return {"current": row.full_name, "previous": json.loads(row.previous_names or "[]"),
            "at": row.changed_at.isoformat() if row.changed_at else None}


def _names_for(rename: Optional[Dict[str, Any]], names: List[str]) -> List[str]:
    return [rename["current"], *(n for n in names if n != rename["current"])] if rename else names


def _form_row(fm: Form, values: Dict[str, Any], filenames: Dict[int, str]) -> Dict[str, Any]:
    return {
        "id": fm.id, "batch_id": fm.batch_id, "page_index": fm.page_index,
        "filename": filenames.get(fm.source_file_id, ""), "doc_type": fm.doc_type, "workflow": fm.workflow,
        "patient_link": fm.patient_link, "patient_id": fm.patient_id,
        "created_at": fm.created_at.isoformat() if fm.created_at else None,
        "fields": values, "doc_meta": load_value(fm.doc_meta),
    }


@router.get("/patients/{pid}")
def patient_file(pid: str, s: Session = Depends(get_session), user: User = Depends(require_roles(*ALL_STAFF))):
    key = patient_key(pid)
    if key is None:
        raise HTTPException(404, "patient not found")
    filed = _linked_forms(s, key)
    suggested = _linked_forms(s, key, links=(LINK_SUGGESTED,))
    if not filed and not suggested:
        raise HTTPException(404, "patient not found")
    every = filed + suggested
    values = _field_values(s, [f.id for f in every])
    filenames = {sf.id: sf.filename for sf in s.exec(
        select(SourceFile).where(SourceFile.id.in_({f.source_file_id for f in every}))).all()}
    rows = {fm.id: _form_row(fm, values[fm.id], filenames) for fm in every}
    names = list(dict.fromkeys(n for n in (_name_of(fm, values[fm.id]) for fm in filed) if n))
    rename = _rename_of(s, key)
    audit.record(s, user, "patient_viewed", "patient", 0, after={"patient_id": key})
    s.commit()
    commitments = [rows[f.id] for f in filed if f.doc_type == "commitment"]
    return {
        "patient_id": key,
        "names": _names_for(rename, names),
        "name_change": rename,
        "commitments": sorted(commitments, key=lambda r: r["fields"].get("receipt_date") or r["created_at"] or "",
                              reverse=True),
        "documents": [rows[f.id] for f in filed if f.doc_type != "commitment"],
        "suggested": [rows[f.id] for f in suggested],
        "pending_approval": sum(1 for r in commitments if r["workflow"] == "pending_approval"),
    }


@router.post("/forms/{form_id}/patient")
def link(form_id: int, body: LinkBody, s: Session = Depends(get_session),
         user: User = Depends(require_roles(*ALL_STAFF))):
    """A person decides: confirm a suggested link, reject it, or file the form under another ID."""
    form = s.get(Form, form_id)
    if form is None:
        raise HTTPException(404, "form not found")
    before = {"patient_id": form.patient_id, "patient_link": form.patient_link}
    if body.action == "confirm":
        if form.patient_id is None:
            raise HTTPException(409, {"code": "no_patient", "detail": "nothing to confirm"})
        form.patient_link = LINK_MANUAL
    elif body.action == "reject":
        form.patient_link = LINK_REJECTED
    elif body.action == "set":
        key = patient_key(body.patient_id)
        if key is None:
            raise HTTPException(422, {"code": "bad_patient_id", "detail": "not an ID number"})
        form.patient_id, form.patient_link = key, LINK_MANUAL
    else:
        raise HTTPException(422, {"code": "bad_action", "detail": body.action})
    s.add(form)
    audit.record(s, user, "patient_link", "form", form.id, before=before,
                 after={"patient_id": form.patient_id, "patient_link": form.patient_link})
    s.commit()
    events.bump(form.batch_id)
    return {"ok": True, "patient_id": form.patient_id, "patient_link": form.patient_link}
