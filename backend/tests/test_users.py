"""User management (roadmap 2ד): admin CRUD, several roles per user, soft delete, last-admin guard,
token revocation — on the real JWT path."""
import json

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app import db
from app.main import app
from app.models import AuditLog, User

pytestmark = pytest.mark.no_auth_override


def _login(client, username, password="demo1234"):
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    return {"Authorization": f"Bearer {r.json()['token']}"} if r.status_code == 200 else None


def _create(client, admin, username="dana", roles=("intake", "approver"), password="secret1"):
    return client.post("/api/admin/users", headers=admin,
                       json={"username": username, "display_name": "דנה", "roles": list(roles), "password": password})


def test_admin_is_seeded_and_only_admin_manages_users(tmp_env):
    with TestClient(app) as client:
        admin = _login(client, "admin1")
        assert admin is not None
        assert client.get("/api/admin/users", headers=admin).status_code == 200
        manager = _login(client, "manager1")
        assert client.get("/api/admin/users", headers=manager).status_code == 403
        roles = client.get("/api/admin/roles", headers=admin).json()
        assert "admin" in roles["roles"] and "users" in roles["permissions"]["admin"]


def test_create_user_with_two_roles_who_can_do_both(tmp_env):
    with TestClient(app) as client:
        admin = _login(client, "admin1")
        r = _create(client, admin)
        assert r.status_code == 201
        assert r.json()["roles"] == ["intake", "approver"]
        assert _create(client, admin).json()["detail"]["code"] == "username_taken"
        dana = _login(client, "dana", "secret1")
        me = client.get("/api/auth/me", headers=dana).json()
        assert set(me["roles"]) == {"intake", "approver"}
        assert client.get("/api/queue/me?role=approver", headers=dana).json()["role"] == "approver"
        assert client.get("/api/queue/me?role=intake", headers=dana).json()["role"] == "intake"
        assert client.get("/api/queue/me?role=lab_manager", headers=dana).json()["role"] == "intake"  # not held


def test_validation_errors(tmp_env):
    with TestClient(app) as client:
        admin = _login(client, "admin1")
        assert _create(client, admin, roles=()).json()["detail"]["code"] == "roles_required"
        assert _create(client, admin, password="123").json()["detail"]["code"] == "password_too_short"


def test_deactivate_is_soft_and_revokes_tokens(tmp_env):
    with TestClient(app) as client:
        admin = _login(client, "admin1")
        uid = _create(client, admin).json()["id"]
        dana = _login(client, "dana", "secret1")
        assert client.get("/api/auth/me", headers=dana).status_code == 200
        assert client.delete(f"/api/admin/users/{uid}", headers=admin).status_code == 200
        assert client.get("/api/auth/me", headers=dana).status_code == 401
        assert _login(client, "dana", "secret1") is None
        with Session(db.get_engine()) as s:
            assert s.get(User, uid) is not None  # still there: history stays
        listed = client.get("/api/admin/users?active=false", headers=admin).json()
        assert [u["username"] for u in listed] == ["dana"]


def test_password_reset_and_role_change_revoke_old_tokens(tmp_env):
    with TestClient(app) as client:
        admin = _login(client, "admin1")
        uid = _create(client, admin, roles=("intake",)).json()["id"]
        old = _login(client, "dana", "secret1")
        client.post(f"/api/admin/users/{uid}/reset-password", headers=admin, json={"password": "newpass1"})
        assert client.get("/api/auth/me", headers=old).status_code == 401
        new = _login(client, "dana", "newpass1")
        client.patch(f"/api/admin/users/{uid}", headers=admin, json={"roles": ["approver"]})
        assert client.get("/api/auth/me", headers=new).status_code == 401
        again = _login(client, "dana", "newpass1")
        assert client.get("/api/auth/me", headers=again).json()["roles"] == ["approver"]


def test_last_admin_cannot_be_removed(tmp_env):
    with TestClient(app) as client:
        admin = _login(client, "admin1")
        me = client.get("/api/auth/me", headers=admin).json()
        r = client.delete(f"/api/admin/users/{me['id']}", headers=admin)
        assert r.status_code == 409 and r.json()["detail"]["code"] == "last_admin"
        r = client.patch(f"/api/admin/users/{me['id']}", headers=admin, json={"roles": ["lab_manager"]})
        assert r.json()["detail"]["code"] == "last_admin"
        _create(client, admin, username="second", roles=("admin",))
        assert client.patch(f"/api/admin/users/{me['id']}", headers=admin,
                            json={"roles": ["lab_manager"]}).status_code == 200


def test_user_changes_are_audited_without_password(tmp_env):
    with TestClient(app) as client:
        admin = _login(client, "admin1")
        uid = _create(client, admin).json()["id"]
        client.post(f"/api/admin/users/{uid}/reset-password", headers=admin, json={"password": "another1"})
    with Session(db.get_engine()) as s:
        rows = s.exec(select(AuditLog).where(AuditLog.entity == "user", AuditLog.entity_id == uid)).all()
    assert [r.action for r in rows] == ["user_created", "password_reset"]
    dumped = json.dumps([[r.before, r.after] for r in rows])
    assert "pbkdf2" not in dumped and "secret1" not in dumped and "another1" not in dumped


def test_list_shows_last_login(tmp_env):
    with TestClient(app) as client:
        admin = _login(client, "admin1")
        _login(client, "manager1")
        rows = {u["username"]: u for u in client.get("/api/admin/users", headers=admin).json()}
        assert rows["manager1"]["last_login_at"] is not None
        assert rows["intake1"]["last_login_at"] is None
