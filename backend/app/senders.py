"""A sender that a person approved but the closed list lacked joins the list, so it does not raise the alert again."""
import json
from datetime import datetime
from typing import Any, Optional

from sqlmodel import Session

from app import audit
from app.config import get_settings
from app.models import ConfigEntry, User
from validators.senders import add_sender


def learn_sender(s: Session, user: Optional[User], value: Any, form_id: Optional[int] = None) -> bool:
    """Add an approved sender value to the stored list if it is not there. The caller commits."""
    if not isinstance(value, str) or not value.strip():
        return False
    row = s.get(ConfigEntry, "senders")
    cfg = json.loads(row.data) if row is not None else get_settings()._yaml("senders.yaml")
    if not add_sender(cfg, value):
        return False
    row = row or ConfigEntry(name="senders", data="{}")
    row.data, row.updated_at = json.dumps(cfg, ensure_ascii=False), datetime.utcnow()
    s.add(row)
    audit.record(s, user, "sender_added", "config", 0, form_id=form_id, after={"sender": " ".join(value.split())})
    return True
