"""Approval workflow of a form, separate from its pipeline status.

needs_fix ──submit──▶ pending_approval ──approve──▶ approved
returned  ──submit──▶        │
    ▲                        └──return (comment)──▶ returned
"""
import json
from typing import Iterable, Optional

from fastapi import HTTPException
from sqlmodel import Session, select

from app import audit
from app.fields import LEVEL_OK
from app.models import Field, Form, User
from app.senders import learn_sender

NEEDS_FIX = "needs_fix"
PENDING_APPROVAL = "pending_approval"
RETURNED = "returned"
APPROVED = "approved"
WORKFLOW_STATES = (NEEDS_FIX, PENDING_APPROVAL, RETURNED, APPROVED)

# action -> (allowed from-states, to-state)
TRANSITIONS = {
    "submit": ({NEEDS_FIX, RETURNED}, PENDING_APPROVAL),
    "approve": ({PENDING_APPROVAL}, APPROVED),
    "return": ({PENDING_APPROVAL}, RETURNED),
}


# Form-level codes that are only informative: they never hold a form back from approval on their own.
INFO_FORM_REASONS = {"merged_pages"}


def initial_workflow(levels: Iterable[str], form_reasons: Optional[Iterable[str]] = None) -> str:
    """A form the model read entirely with confidence skips the intake clerk.

    A form-level doubt (several commitments on the page, a poor photo, a possible duplicate...)
    always sends it to the clerk, even if every field looked fine.
    """
    levels = list(levels)
    if any(r not in INFO_FORM_REASONS for r in (form_reasons or ())):
        return NEEDS_FIX
    return PENDING_APPROVAL if levels and all(lv == LEVEL_OK for lv in levels) else NEEDS_FIX


def transition(s: Session, form: Form, user: Optional[User], action: str, comment: Optional[str] = None) -> Form:
    """Move a form along the workflow and audit it. The caller commits."""
    allowed, to = TRANSITIONS[action]
    if form.status != "done" or form.workflow not in allowed:
        raise HTTPException(409, f"cannot {action} a form in state {form.workflow or form.status}")
    before = form.workflow
    form.workflow = to
    if action == "return":
        form.approver_comment = comment
    elif action == "approve":
        form.approver_comment = None
        sender = s.exec(select(Field.value).where(Field.form_id == form.id, Field.name == "sender")).first()
        learn_sender(s, user, json.loads(sender) if sender else None, form.id)  # approved: the list now knows it
    s.add(form)
    audit.record(s, user, "status_change", "form", form.id, before={"workflow": before},
                 after={"workflow": to}, comment=comment)
    return form
