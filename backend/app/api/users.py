"""User management for the system admin: create, edit, roles, password reset, deactivate (soft delete).

Users are never deleted: their audit history and form assignments stay. Every change is audited
(without the password hash) and bumps token_version where access changes, so old tokens stop working.
"""
import json
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app import audit
from app.auth import (ROLE_ADMIN, ROLE_PERMISSIONS, ROLES, hash_password, primary_role, require_roles, roles_of,
                      user_dict)
from app.db import get_session
from app.logging_utils import get_logger, log_event
from app.models import User

router = APIRouter(prefix="/api/admin", tags=["users"], dependencies=[Depends(require_roles(ROLE_ADMIN))])
log = get_logger("api")

MIN_PASSWORD = 6


class UserCreate(BaseModel):
    username: str
    display_name: str = ""
    roles: List[str]
    password: str


class UserUpdate(BaseModel):
    username: Optional[str] = None
    display_name: Optional[str] = None
    roles: Optional[List[str]] = None
    active: Optional[bool] = None


class PasswordBody(BaseModel):
    password: str


def _error(status: int, code: str, detail: str = "") -> HTTPException:
    return HTTPException(status, {"code": code, "detail": detail or code})


def _clean_roles(roles: List[str]) -> List[str]:
    out = [r for r in ROLES if r in set(roles)]  # stable order, known roles only
    if not out:
        raise _error(422, "roles_required", "a user needs at least one role")
    return out


def _check_password(pw: str) -> None:
    if len(pw or "") < MIN_PASSWORD:
        raise _error(422, "password_too_short", f"at least {MIN_PASSWORD} characters")


def _snapshot(u: User) -> Dict[str, Any]:
    """What the audit log keeps about a user: never the password hash."""
    return {"username": u.username, "display_name": u.display_name, "roles": roles_of(u), "active": bool(u.active)}


def _active_admins(s: Session) -> List[User]:
    return [u for u in s.exec(select(User).where(User.active == True)).all()  # noqa: E712
            if ROLE_ADMIN in roles_of(u)]


def _get(s: Session, user_id: int) -> User:
    u = s.get(User, user_id)
    if u is None:
        raise HTTPException(404, "user not found")
    return u


def _would_leave_no_admin(s: Session, target: User, roles: List[str], active: bool) -> bool:
    if ROLE_ADMIN not in roles_of(target) or not target.active:
        return False
    if ROLE_ADMIN in roles and active:
        return False
    return len(_active_admins(s)) <= 1


def _username_taken(s: Session, username: str, other_than: Optional[int] = None) -> bool:
    found = s.exec(select(User).where(User.username == username)).first()
    return found is not None and found.id != other_than


@router.get("/roles")
def roles() -> Dict[str, Any]:
    return {"roles": list(ROLES), "permissions": ROLE_PERMISSIONS}


@router.get("/users")
def list_users(q: Optional[str] = None, role: Optional[str] = None, active: Optional[bool] = None,
               s: Session = Depends(get_session)):
    users = s.exec(select(User).order_by(User.id)).all()
    needle = (q or "").strip().casefold()
    out = []
    for u in users:
        if needle and needle not in u.username.casefold() and needle not in (u.display_name or "").casefold():
            continue
        if role and role not in roles_of(u):
            continue
        if active is not None and bool(u.active) != active:
            continue
        out.append({**user_dict(u), "created_at": u.created_at.isoformat() if u.created_at else None,
                    "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None})
    return out


@router.post("/users", status_code=201)
def create_user(body: UserCreate, s: Session = Depends(get_session), admin: User = Depends(require_roles(ROLE_ADMIN))):
    username = body.username.strip()
    if not username:
        raise _error(422, "username_required")
    if _username_taken(s, username):
        raise _error(409, "username_taken")
    _check_password(body.password)
    roles = _clean_roles(body.roles)
    u = User(username=username, display_name=body.display_name.strip(), roles=json.dumps(roles),
             role=primary_role(roles), password_hash=hash_password(body.password))
    s.add(u)
    s.flush()
    audit.record(s, admin, "user_created", "user", u.id, after=_snapshot(u))
    s.commit()
    s.refresh(u)
    log_event(log, "user_created", user_id=u.id, by=admin.id)
    return user_dict(u)


@router.patch("/users/{user_id}")
def update_user(user_id: int, body: UserUpdate, s: Session = Depends(get_session),
                admin: User = Depends(require_roles(ROLE_ADMIN))):
    u = _get(s, user_id)
    before = _snapshot(u)
    roles = _clean_roles(body.roles) if body.roles is not None else roles_of(u)
    active = body.active if body.active is not None else bool(u.active)
    if _would_leave_no_admin(s, u, roles, active):
        raise _error(409, "last_admin", "the last active admin cannot lose the admin role or be deactivated")
    if body.username is not None:
        username = body.username.strip()
        if not username:
            raise _error(422, "username_required")
        if _username_taken(s, username, other_than=u.id):
            raise _error(409, "username_taken")
        u.username = username
    if body.display_name is not None:
        u.display_name = body.display_name.strip()
    access_changed = roles != roles_of(u) or active != bool(u.active)
    u.roles, u.role, u.active = json.dumps(roles), primary_role(roles), active
    if access_changed:
        u.token_version = (u.token_version or 0) + 1  # the next request re-authenticates with the new rights
    u.updated_at = datetime.utcnow()
    s.add(u)
    action = "user_deactivated" if before["active"] and not active else "user_updated"
    audit.record(s, admin, action, "user", u.id, before=before, after=_snapshot(u))
    s.commit()
    s.refresh(u)
    log_event(log, action, user_id=u.id, by=admin.id)
    return user_dict(u)


@router.post("/users/{user_id}/reset-password")
def reset_password(user_id: int, body: PasswordBody, s: Session = Depends(get_session),
                   admin: User = Depends(require_roles(ROLE_ADMIN))):
    u = _get(s, user_id)
    _check_password(body.password)
    u.password_hash = hash_password(body.password)
    u.token_version = (u.token_version or 0) + 1
    u.updated_at = datetime.utcnow()
    s.add(u)
    audit.record(s, admin, "password_reset", "user", u.id)
    s.commit()
    log_event(log, "password_reset", user_id=u.id, by=admin.id)
    return {"ok": True}


@router.delete("/users/{user_id}")
def deactivate_user(user_id: int, s: Session = Depends(get_session),
                    admin: User = Depends(require_roles(ROLE_ADMIN))):
    """Soft delete: the user can no longer sign in; history and assignments stay."""
    return update_user(user_id, UserUpdate(active=False), s, admin)
