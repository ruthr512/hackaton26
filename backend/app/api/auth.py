from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import (builtin_credentials_ok, builtin_login_allowed, builtin_user, create_builtin_token, create_token,
                      get_current_user, user_dict, verify_password)
from app.db import get_session
from app.logging_utils import get_logger, log_event
from app.models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])
log = get_logger("api")


class LoginBody(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginBody, s: Session = Depends(get_session)):
    username = body.username.strip()
    if builtin_credentials_ok(username, body.password) and builtin_login_allowed(s):
        log_event(log, "login_builtin_manager")
        return {"token": create_builtin_token(), "user": user_dict(builtin_user())}
    user = s.exec(select(User).where(User.username == username)).first()
    if user is None or not user.active or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "wrong username or password")
    user.last_login_at = datetime.utcnow()
    s.add(user)
    s.commit()
    log_event(log, "login", user_id=user.id)
    return {"token": create_token(user), "user": user_dict(user)}


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return user_dict(user)
