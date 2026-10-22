import json
from pathlib import Path
from typing import Any, List, Optional, Union

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlmodel import Session, select

from app import audit, corrections, events, identity, patients
from app.api.batches import start_background
from app.api.serialize import field_dict, load_value
from app.auth import check_batch_view, check_form_editor, get_current_user
from app.config import get_settings
from app.db import get_session
from app.fields import LEVEL_EMPTY, LEVEL_OK
from app.logging_utils import get_logger, log_event
from app.models import AuditLog, Batch, Correction, Field, Form, User
from app.senders import learn_sender
from app.workflow import APPROVED
from pipeline.normalizers import normalize_field
from pipeline.runner import retry_form
from validators.senders import canonical_names

router = APIRouter(prefix="/api", tags=["forms"], dependencies=[Depends(get_current_user)])
log = get_logger("api")


class FieldUpdate(BaseModel):
    value: Optional[Union[str, List[str]]] = None
    version: Optional[int] = None  # the version the editor saw; a newer one on the server means a conflict


class DocTypeBody(BaseModel):
    doc_type: str


def _editable_form(s: Session, form_id: int, user: User) -> Form:
    form = s.get(Form, form_id)
    if form is None:
        raise HTTPException(404, "form not found")
    check_form_editor(s, user, form)
    if form.status == "processing":
        raise HTTPException(409, "form is still processing")
    if form.workflow == APPROVED:
        raise HTTPException(409, "form is already approved")
    return form


def _last_editor(s: Session, fld: Field) -> Optional[str]:
    row = s.exec(select(AuditLog).where(AuditLog.entity == "field", AuditLog.entity_id == fld.id,
                                        AuditLog.user_id != None)  # noqa: E711
                 .order_by(AuditLog.at.desc())).first()
    who = s.get(User, row.user_id) if row else None
    return (who.display_name or who.username) if who else None


# the page image is replaced when classify turns / straightens it: never serve a stale copy
_NO_CACHE = {"Cache-Control": "no-cache, must-revalidate"}


@router.get("/forms/{form_id}/image")
def form_image(form_id: int, s: Session = Depends(get_session), user: User = Depends(get_current_user)):
    form = s.get(Form, form_id)
    if form is not None:
        check_batch_view(s, user, s.get(Batch, form.batch_id))
    if form is not None and form.image_data:
        return Response(form.image_data, media_type="image/png", headers=_NO_CACHE)
    if form is None or not form.image_path or not Path(form.image_path).exists():
        raise HTTPException(404, "image not found")
    return FileResponse(form.image_path, media_type="image/png", headers=_NO_CACHE)


@router.delete("/forms/{form_id}")
def delete_form(form_id: int, s: Session = Depends(get_session), user: User = Depends(get_current_user)):
    """Throw a commitment away (e.g. one whose name clashes with the patient file and was scanned wrongly)."""
    form = _editable_form(s, form_id, user)
    if s.exec(select(Form.id).where(Form.parent_form_id == form_id)).first() is not None:
        raise HTTPException(409, {"code": "has_merged_pages", "detail": "split the merged pages first"})
    batch_id = form.batch_id
    for row in s.exec(select(Correction).where(Correction.form_id == form_id)).all():
        s.delete(row)  # never approved, so it never became a lesson
    for fld in s.exec(select(Field).where(Field.form_id == form_id)).all():
        s.delete(fld)
    audit.record(s, user, "form_deleted", "form", form_id, form_id=form_id,
                 before={"workflow": form.workflow, "patient_id": form.patient_id})
    s.delete(form)
    s.commit()
    events.bump(batch_id)
    log_event(log, "form_deleted", form_id=form_id, user_id=user.id)
    return {"ok": True}


@router.post("/forms/{form_id}/retry")
async def retry(form_id: int, s: Session = Depends(get_session), user: User = Depends(get_current_user)):
    form = s.get(Form, form_id)
    if form is None:
        raise HTTPException(404, "form not found")
    check_form_editor(s, user, form)
    if form.status == "processing":
        raise HTTPException(409, "form is already processing")
    form.status, form.error = "processing", None
    s.add(form)
    s.commit()
    start_background(retry_form(form_id))
    return {"ok": True}


@router.post("/forms/{form_id}/doc-type")
async def set_doc_type(form_id: int, body: DocTypeBody, s: Session = Depends(get_session),
                       user: User = Depends(get_current_user)):
    """The user overrides what the page is. "commitment" reads it now; another type stops reading it."""
    from pipeline.base import SKIPPED_TYPES

    if body.doc_type not in ("commitment",) + SKIPPED_TYPES:
        raise HTTPException(422, "unknown document type")
    form = _editable_form(s, form_id, user)
    if form.parent_form_id is not None:
        raise HTTPException(409, "form is merged into another form")
    before = {"doc_type": form.doc_type, "workflow": form.workflow}
    if body.doc_type == "commitment":
        form.status, form.error, form.error_code = "processing", None, None
        s.add(form)
        audit.record(s, user, "doc_type_changed", "form", form.id, before=before, after={"doc_type": "commitment"})
        s.commit()
        start_background(retry_form(form_id, forced_type="commitment"))
    else:
        for fld in s.exec(select(Field).where(Field.form_id == form_id)).all():
            corrections.discard(s, fld)
            s.delete(fld)
        form.doc_type, form.workflow = body.doc_type, None
        s.add(form)
        audit.record(s, user, "doc_type_changed", "form", form.id, before=before,
                     after={"doc_type": body.doc_type, "workflow": None})
        s.commit()
    log_event(log, "doc_type_changed", form_id=form_id, doc_type=body.doc_type, user_id=user.id)
    return {"ok": True}


@router.post("/forms/{form_id}/merge-previous")
def merge_previous(form_id: int, s: Session = Depends(get_session), user: User = Depends(get_current_user)):
    """This page continues the commitment on the page before it."""
    from pipeline import merge

    form = _editable_form(s, form_id, user)
    parent = merge.merge_previous(s, form, user)
    log_event(log, "pages_merged_manually", form_id=form_id, parent_id=parent.id, user_id=user.id)
    return {"ok": True, "parent_form_id": parent.id}


@router.post("/forms/{form_id}/split")
def split_pages(form_id: int, s: Session = Depends(get_session), user: User = Depends(get_current_user)):
    """Undo a merge: every page becomes its own form again."""
    from pipeline import merge

    form = _editable_form(s, form_id, user)
    ids = merge.split(s, form, user)
    log_event(log, "pages_split", form_id=form_id, pages=len(ids), user_id=user.id)
    return {"ok": True, "form_ids": [form_id] + ids}


def _get_field(s: Session, field_id: int, user: User) -> Field:
    """The field, if this user may edit its form. Approved forms are frozen."""
    fld = s.get(Field, field_id)
    if fld is None:
        raise HTTPException(404, "field not found")
    form = s.get(Form, fld.form_id)
    check_form_editor(s, user, form)
    if form.workflow == APPROVED:
        raise HTTPException(409, "form is already approved")
    return fld


def _snapshot(fld: Field) -> dict:
    return {"value": load_value(fld.value), "level": fld.level}


def _audit(s: Session, user: User, action: str, fld: Field, before: dict) -> None:
    audit.record(s, user, action, "field", fld.id, form_id=fld.form_id, before={"name": fld.name, **before},
                 after={"name": fld.name, **_snapshot(fld)})
    if fld.name == "id_number":  # a corrected ID moves the form to (or toward) the right patient file
        s.flush()
        patients.link_patient(s, s.get(Form, fld.form_id))


def _changed(s: Session, fld: Field) -> None:
    """Tell live review screens of this batch (SSE) that something changed."""
    form = s.get(Form, fld.form_id)
    if fld.name in ("full_name", "id_number"):  # a confirmed name / ID reaches the other forms of the same ID
        identity.propagate(s, form)
    events.bump(form.batch_id if form else None)


@router.patch("/fields/{field_id}")
def update_field(field_id: int, body: FieldUpdate, s: Session = Depends(get_session),
                 user: User = Depends(get_current_user)):
    """A manual correction is the truth: normalize its format and mark it ok (or empty)."""
    fld = _get_field(s, field_id, user)
    if body.version is not None and body.version != (fld.version or 0):
        raise HTTPException(409, {"code": "conflict", "by": _last_editor(s, fld), "field": field_dict(fld)})
    before = _snapshot(fld)
    value: Any = body.value
    if isinstance(value, str) and not value.strip():
        value = None
    value, _ = normalize_field(fld.name, value, get_settings().senders)
    fld.value = None if value is None else json.dumps(value, ensure_ascii=False)
    fld.level = LEVEL_EMPTY if value is None else LEVEL_OK
    fld.manually_corrected = True
    fld.version = (fld.version or 0) + 1
    s.add(fld)
    corrections.record(s, user, fld, before)
    if fld.name == "sender":  # typed by a person: the list now knows it
        learn_sender(s, user, value, fld.form_id)
    _audit(s, user, "field_corrected", fld, before)
    if fld.name == "full_name":  # typed over a flagged name change: the patient file takes that name
        identity.confirm_name(s, user, fld, get_settings().pipeline)
    s.commit()
    s.refresh(fld)
    _changed(s, fld)
    log_event(log, "field_corrected", field_id=field_id, form_id=fld.form_id)
    return field_dict(fld)


@router.post("/fields/{field_id}/approve")
def approve_field(field_id: int, s: Session = Depends(get_session), user: User = Depends(get_current_user)):
    fld = _get_field(s, field_id, user)
    before = _snapshot(fld)
    fld.level = LEVEL_EMPTY if fld.value is None else LEVEL_OK
    fld.version = (fld.version or 0) + 1
    s.add(fld)
    if fld.name == "sender":  # approved: the list now knows it, so it is not flagged next time
        learn_sender(s, user, load_value(fld.value), fld.form_id)
    _audit(s, user, "field_approved", fld, before)
    if fld.name == "full_name":  # approved as a name change: the patient file takes the new name
        identity.confirm_name(s, user, fld, get_settings().pipeline)
    s.commit()
    s.refresh(fld)
    _changed(s, fld)
    log_event(log, "field_approved", field_id=field_id, form_id=fld.form_id)
    return field_dict(fld)


@router.post("/fields/{field_id}/reset")
def reset_field(field_id: int, s: Session = Depends(get_session), user: User = Depends(get_current_user)):
    """Undo manual edits: put back what the model originally read (normalized again)."""
    fld = _get_field(s, field_id, user)
    before = _snapshot(fld)
    raw = load_value(fld.raw_value)
    value, _ = normalize_field(fld.name, raw, get_settings().senders)
    fld.value = None if value is None else json.dumps(value, ensure_ascii=False)
    fld.manually_corrected = False
    if value is None:
        fld.level = LEVEL_EMPTY
    elif fld.level == LEVEL_EMPTY or fld.reasons in (None, "", "[]"):
        fld.level = LEVEL_OK
    fld.version = (fld.version or 0) + 1
    s.add(fld)
    corrections.discard(s, fld)
    _audit(s, user, "field_reset", fld, before)
    s.commit()
    s.refresh(fld)
    _changed(s, fld)
    log_event(log, "field_reset", field_id=field_id, form_id=fld.form_id)
    return field_dict(fld)


@router.get("/senders")
def senders():
    return canonical_names(get_settings().senders)
