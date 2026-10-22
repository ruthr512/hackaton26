"""Approval workflow routes, the personal queue of each role, and work assignment."""
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app import audit, identity
from app.api.serialize import load_value
from app.auth import (ROLE_APPROVER, ROLE_INTAKE, ROLE_MANAGER, check_form_editor, get_current_user, has_role,
                      primary_role, require_roles, roles_of, user_dict)
from app.db import get_session
from app.fields import LEVEL_EMPTY, LEVEL_OK, OPTIONAL_FIELDS
from app.logging_utils import get_logger, log_event
from app.models import AuditLog, Batch, Field, Form, SourceFile, User
from app.workflow import APPROVED, NEEDS_FIX, PENDING_APPROVAL, RETURNED, transition

router = APIRouter(prefix="/api", tags=["workflow"])
log = get_logger("api")

QUEUE_LIMIT = 200


class ReturnBody(BaseModel):
    comment: str


class BulkBody(BaseModel):
    ids: List[int]


class AssignBody(BaseModel):
    user_id: int


def _form(s: Session, form_id: int) -> Form:
    form = s.get(Form, form_id)
    if form is None:
        raise HTTPException(404, "form not found")
    return form


_NAME_CHANGE_PENDING = ("the name differs from the one filed under this ID: approve it, or scan a corrected "
                        "commitment / delete this one")


def _name_change_pending(s: Session, form_id: int) -> bool:
    """A name that clashes with the patient file was neither approved nor corrected: the form cannot leave."""
    return identity.open_name_change(s, form_id) is not None


def _start_of_today() -> datetime:
    now = datetime.utcnow()
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def needs_look(f: Field) -> bool:
    """Not yet ok, except an optional field left empty (most forms simply have no referral number)."""
    return f.level != LEVEL_OK and not (f.name in OPTIONAL_FIELDS and f.level == LEVEL_EMPTY)


def form_summaries(s: Session, forms: List[Form]) -> List[Dict[str, Any]]:
    """Queue rows: file/page, key field values, how many fields still need a look, and since when it waits."""
    if not forms:
        return []
    ids = [f.id for f in forms]
    fields: Dict[int, List[Field]] = {i: [] for i in ids}
    for fld in s.exec(select(Field).where(Field.form_id.in_(ids))).all():
        fields[fld.form_id].append(fld)
    names = {sf.id: sf.filename for sf in s.exec(
        select(SourceFile).where(SourceFile.id.in_({f.source_file_id for f in forms}))).all()}
    last_change: Dict[int, AuditLog] = {}
    for row in s.exec(select(AuditLog).where(AuditLog.entity == "form", AuditLog.action == "status_change",
                                             AuditLog.entity_id.in_(ids)).order_by(AuditLog.at)).all():
        last_change[row.entity_id] = row
    users = {u.id: u.display_name or u.username for u in s.exec(select(User)).all()}

    out = []
    for fm in forms:
        flds = {f.name: f for f in fields[fm.id]}
        change = last_change.get(fm.id)
        since = change.at if change else fm.created_at
        out.append({
            "id": fm.id,
            "batch_id": fm.batch_id,
            "filename": names.get(fm.source_file_id, ""),
            "page_index": fm.page_index,
            "workflow": fm.workflow,
            "assigned_to": fm.assigned_to,
            "assigned_name": users.get(fm.assigned_to),
            "approver_comment": fm.approver_comment,
            "flagged": sum(1 for f in flds.values() if needs_look(f)),
            "full_name": load_value(flds["full_name"].value) if "full_name" in flds else None,
            "id_number": load_value(flds["id_number"].value) if "id_number" in flds else None,
            "sender": load_value(flds["sender"].value) if "sender" in flds else None,
            "waiting_since": since.isoformat() if since else None,
            "changed_by": users.get(change.user_id) if change else None,
        })
    return out


# ---------- transitions ----------

def _propagate_identity(s: Session, form_ids: List[int]) -> None:
    """Approved: the name on these forms is now the truth for every other form of the same ID."""
    for form_id in form_ids:
        identity.propagate(s, s.get(Form, form_id))


@router.post("/forms/{form_id}/submit")
def submit(form_id: int, s: Session = Depends(get_session),
           user: User = Depends(require_roles(ROLE_INTAKE, ROLE_MANAGER))):
    form = _form(s, form_id)
    check_form_editor(s, user, form)
    if _name_change_pending(s, form_id):
        raise HTTPException(409, {"code": "name_change_pending", "detail": _NAME_CHANGE_PENDING})
    flagged = sum(1 for f in s.exec(select(Field).where(Field.form_id == form_id)).all() if needs_look(f))
    transition(s, form, user, "submit")
    s.commit()
    log_event(log, "form_submitted", form_id=form_id, user_id=user.id)
    return {"ok": True, "workflow": form.workflow, "flagged": flagged}


@router.post("/forms/approve-bulk")
def approve_bulk(body: BulkBody, s: Session = Depends(get_session),
                 user: User = Depends(require_roles(ROLE_APPROVER, ROLE_MANAGER))):
    approved, skipped = [], []
    for form_id in body.ids:
        form = s.get(Form, form_id)
        if form is None or form.status != "done" or form.workflow != PENDING_APPROVAL                 or _name_change_pending(s, form_id):
            skipped.append(form_id)
            continue
        transition(s, form, user, "approve")
        approved.append(form_id)
    s.commit()
    _propagate_identity(s, approved)
    log_event(log, "forms_bulk_approved", count=len(approved), user_id=user.id)
    return {"approved": approved, "skipped": skipped}


@router.post("/forms/{form_id}/approve")
def approve(form_id: int, s: Session = Depends(get_session),
            user: User = Depends(require_roles(ROLE_APPROVER, ROLE_MANAGER))):
    form = _form(s, form_id)
    if _name_change_pending(s, form_id):
        raise HTTPException(409, {"code": "name_change_pending", "detail": _NAME_CHANGE_PENDING})
    transition(s, form, user, "approve")
    s.commit()
    _propagate_identity(s, [form_id])
    log_event(log, "form_approved", form_id=form_id, user_id=user.id)
    return {"ok": True, "workflow": form.workflow}


@router.post("/forms/{form_id}/return")
def return_form(form_id: int, body: ReturnBody, s: Session = Depends(get_session),
                user: User = Depends(require_roles(ROLE_APPROVER, ROLE_MANAGER))):
    comment = body.comment.strip()
    if not comment:
        raise HTTPException(422, "a comment is required when returning a form")
    form = _form(s, form_id)
    transition(s, form, user, "return", comment=comment)
    s.commit()
    log_event(log, "form_returned", form_id=form_id, user_id=user.id)
    return {"ok": True, "workflow": form.workflow}


@router.post("/batches/{batch_id}/finalize")
def finalize_batch(batch_id: int, s: Session = Depends(get_session),
                   user: User = Depends(require_roles(ROLE_MANAGER))):
    """The manager runs the rest of the flow alone: submit (if needed) and approve every finished form of the batch."""
    batch = s.get(Batch, batch_id)
    if batch is None:
        raise HTTPException(404, "batch not found")
    if batch.status == "processing":
        raise HTTPException(409, "batch is still processing")
    approved, skipped = [], []
    for form in s.exec(select(Form).where(Form.batch_id == batch_id).order_by(Form.id)).all():
        if form.status != "done" or form.workflow not in (NEEDS_FIX, RETURNED, PENDING_APPROVAL):
            skipped.append(form.id)  # failed / still processing / already approved
            continue
        if _name_change_pending(s, form.id):
            skipped.append(form.id)  # the clerk has not decided on the new name yet
            continue
        if form.workflow != PENDING_APPROVAL:
            transition(s, form, user, "submit")
        transition(s, form, user, "approve")
        approved.append(form.id)
    s.commit()
    _propagate_identity(s, approved)
    log_event(log, "batch_finalized", batch_id=batch_id, approved=len(approved), user_id=user.id)
    return {"approved": approved, "skipped": skipped}


@router.post("/forms/{form_id}/assign")
def assign(form_id: int, body: AssignBody, s: Session = Depends(get_session),
           user: User = Depends(require_roles(ROLE_MANAGER))):
    form = _form(s, form_id)
    target = s.get(User, body.user_id)
    if target is None or not target.active or not has_role(target, ROLE_INTAKE):
        raise HTTPException(422, "forms can only be assigned to an active intake clerk")
    before = form.assigned_to
    form.assigned_to = target.id
    s.add(form)
    audit.record(s, user, "assigned", "form", form.id, before={"assigned_to": before},
                 after={"assigned_to": target.id})
    s.commit()
    log_event(log, "form_assigned", form_id=form_id, user_id=user.id, to=target.id)
    return {"ok": True, "assigned_to": target.id}


# ---------- personal queues ----------

def _intake_queue(s: Session, user: User) -> Dict[str, Any]:
    my_batches = select(Batch.id).where(Batch.uploaded_by == user.id)
    forms = s.exec(
        select(Form).where(
            Form.status == "done", Form.workflow.in_([NEEDS_FIX, RETURNED]),
            (Form.assigned_to == user.id) | ((Form.assigned_to == None) & Form.batch_id.in_(my_batches)),  # noqa: E711
        ).order_by(Form.created_at).limit(QUEUE_LIMIT)
    ).all()
    rows = form_summaries(s, forms)
    rows.sort(key=lambda r: r["waiting_since"] or "")  # oldest first

    uploads = []
    assigned = select(Form.batch_id).where(Form.assigned_to == user.id)
    for b in s.exec(select(Batch).where((Batch.uploaded_by == user.id) | Batch.id.in_(assigned))
                    .order_by(Batch.id.desc()).limit(10)).all():
        wfs = s.exec(select(Form.status, Form.workflow).where(Form.batch_id == b.id)).all()
        uploads.append({
            "id": b.id, "created_at": b.created_at.isoformat(), "status": b.status,
            "forms": len(wfs), "done": sum(1 for st, _ in wfs if st == "done"),
            "failed": sum(1 for st, _ in wfs if st == "failed"),
            "approved": sum(1 for st, wf in wfs if st == "done" and wf == APPROVED),
        })

    today = _start_of_today()
    received = len(s.exec(select(Form.id).where(Form.batch_id.in_(my_batches), Form.created_at >= today)).all())
    corrected = len(set(s.exec(select(AuditLog.form_id).where(
        AuditLog.user_id == user.id, AuditLog.action == "field_corrected", AuditLog.at >= today)).all()))
    submitted = sum(1 for a in s.exec(select(AuditLog.after).where(
        AuditLog.user_id == user.id, AuditLog.action == "status_change", AuditLog.at >= today)).all()
        if (load_value(a) or {}).get("workflow") == PENDING_APPROVAL)
    return {
        "role": ROLE_INTAKE,
        "forms": rows,
        "uploads": uploads,
        "today": {"received": received, "corrected": corrected, "submitted": submitted, "waiting": len(rows)},
    }


def _approver_queue(s: Session, user: User) -> Dict[str, Any]:
    forms = s.exec(select(Form).where(Form.status == "done", Form.workflow == PENDING_APPROVAL)
                   .order_by(Form.created_at).limit(QUEUE_LIMIT)).all()
    rows = form_summaries(s, forms)
    rows.sort(key=lambda r: r["waiting_since"] or "")

    mine = s.exec(select(AuditLog).where(AuditLog.user_id == user.id, AuditLog.action == "status_change")
                  .order_by(AuditLog.at.desc()).limit(50)).all()
    batch_of = {i: b for i, b in s.exec(select(Form.id, Form.batch_id).where(
        Form.id.in_({a.entity_id for a in mine}))).all()} if mine else {}
    history = []
    for a in mine:
        to = (load_value(a.after) or {}).get("workflow")
        if to in (APPROVED, RETURNED):
            history.append({"form_id": a.entity_id, "batch_id": batch_of.get(a.entity_id), "workflow": to,
                            "at": a.at.isoformat(), "comment": a.comment})
    today = _start_of_today().isoformat()
    return {
        "role": ROLE_APPROVER,
        "forms": rows,
        "history": history[:20],
        "today": {
            "approved": sum(1 for h in history if h["workflow"] == APPROVED and h["at"] >= today),
            "returned": sum(1 for h in history if h["workflow"] == RETURNED and h["at"] >= today),
            "waiting": len(rows),
        },
    }


def workload(s: Session) -> List[Dict[str, Any]]:
    week_ago = datetime.utcnow() - timedelta(days=7)
    out = []
    for u in s.exec(select(User).where(User.active == True).order_by(User.id)).all():  # noqa: E712
        if has_role(u, ROLE_INTAKE):
            in_queue = len(s.exec(select(Form.id).where(
                Form.assigned_to == u.id, Form.status == "done", Form.workflow.in_([NEEDS_FIX, RETURNED]))).all())
        elif has_role(u, ROLE_APPROVER):
            in_queue = len(s.exec(select(Form.id).where(
                Form.status == "done", Form.workflow == PENDING_APPROVAL)).all())
        else:
            in_queue = None
        handled = len(set(s.exec(select(AuditLog.form_id).where(
            AuditLog.user_id == u.id, AuditLog.at >= week_ago,
            AuditLog.action.in_(["status_change", "field_corrected"]))).all()))
        out.append({**user_dict(u), "in_queue": in_queue, "handled_week": handled})
    return out


@router.get("/queue/me")
def my_queue(s: Session = Depends(get_session), user: User = Depends(get_current_user),
             flagged: Optional[str] = None, role: Optional[str] = None):
    """The queue of one of the user's roles (?role=); by default the first work queue they hold."""
    held = roles_of(user)
    if role not in held:
        role = next((r for r in (ROLE_INTAKE, ROLE_APPROVER) if r in held), primary_role(held))
    if role == ROLE_INTAKE:
        return _intake_queue(s, user)
    if role == ROLE_APPROVER:
        data = _approver_queue(s, user)
        if flagged == "none":
            data["forms"] = [r for r in data["forms"] if r["flagged"] == 0]
        elif flagged == "some":
            data["forms"] = [r for r in data["forms"] if 1 <= r["flagged"] <= 2]
        elif flagged == "many":
            data["forms"] = [r for r in data["forms"] if r["flagged"] >= 3]
        return data
    return {"role": role, "workload": workload(s)}


@router.get("/users")
def list_users(s: Session = Depends(get_session), user: User = Depends(require_roles(ROLE_MANAGER))):
    return [user_dict(u) for u in s.exec(select(User).where(User.active == True).order_by(User.id)).all()]  # noqa: E712


@router.get("/forms/queue")
def intake_forms(s: Session = Depends(get_session), user: User = Depends(require_roles(ROLE_MANAGER))):
    """All forms waiting for an intake clerk, so the manager can reassign them."""
    forms = s.exec(select(Form).where(Form.status == "done", Form.workflow.in_([NEEDS_FIX, RETURNED]))
                   .order_by(Form.created_at).limit(QUEUE_LIMIT)).all()
    return form_summaries(s, forms)
