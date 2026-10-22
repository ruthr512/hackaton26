"""The sender list: seeded with the full list, merged into old DBs, and extended when an unknown sender is approved."""
import json

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app import db
from app.config import get_settings
from app.main import app
from app.models import AuditLog, ConfigEntry, Field
from tests.test_workflow import _audit, _seed_form
from validators.senders import add_sender, canonical_names, is_canonical, merge_defaults

NEW = "מרפאה חדשה בע״מ"


def _stored():
    with Session(db.get_engine()) as s:
        return json.loads(s.get(ConfigEntry, "senders").data)


def _set_sender(form_id, value):
    with Session(db.get_engine()) as s:
        fld = s.exec(select(Field).where(Field.form_id == form_id, Field.name == "sender")).one()
        fld.value = json.dumps(value, ensure_ascii=False)
        s.add(fld)
        s.commit()
        return fld.id


def test_seed_has_the_full_list(tmp_env):
    db.seed_config()
    db.migrate_senders()
    names = canonical_names(get_settings().senders)
    assert len(names) == len(set(names)) == 49
    assert {"כללית", "מכבי", "מאוחדת", "לאומית", "משגב לדך", 'בית החולים המשפחה ה"קדושה" (האיטלקי)'} <= set(names)


def test_old_db_gets_missing_names_once(tmp_env):
    old = {"match_threshold": 85, "senders": [{"name": "שיבא", "aliases": ["sheba"]}, {"name": "מכבי", "aliases": []}]}
    with Session(db.get_engine()) as s:
        s.add(ConfigEntry(name="senders", data=json.dumps(old, ensure_ascii=False)))
        s.commit()
    db.migrate_senders()
    cfg = _stored()
    names = canonical_names(cfg)
    assert "שיבא" in names and 'המרכז הרפואי ע"ש חיים שיבא - תל השומר' not in names  # kept, full name is an alias
    assert "מאוחדת" in names and 'מרכז רפואי מאיר' in names and len(names) == 49
    cfg["senders"] = [s for s in cfg["senders"] if s["name"] != "מאוחדת"]
    with Session(db.get_engine()) as s:
        s.get(ConfigEntry, "senders").data = json.dumps(cfg, ensure_ascii=False)
        s.commit()
    db.migrate_senders()  # applied once: a name the manager removed does not return
    assert "מאוחדת" not in canonical_names(_stored())


def test_add_sender_skips_known():
    cfg = {"match_threshold": 85, "senders": [{"name": "מכבי", "aliases": ["maccabi"]}]}
    assert not add_sender(cfg, "maccabi") and not add_sender(cfg, "  ")
    assert add_sender(cfg, f"  {NEW} ") and is_canonical(NEW, cfg)
    assert not merge_defaults(cfg, {"senders": [{"name": "מכבי"}]})


def test_approving_a_field_adds_the_sender(tmp_env):
    db.seed_config()
    _, form_id, _ = _seed_form(workflow="needs_fix", levels=("ok", "review"))
    field_id = _set_sender(form_id, NEW)
    assert not is_canonical(NEW, get_settings().senders)
    r = TestClient(app).post(f"/api/fields/{field_id}/approve")
    assert r.status_code == 200
    assert is_canonical(NEW, get_settings().senders)
    assert len(_audit("sender_added")) == 1


def test_approving_the_form_adds_the_sender(tmp_env, as_role):
    db.seed_config()
    as_role("approver")
    _, form_id, _ = _seed_form(workflow="pending_approval", levels=("ok", "review"))
    _set_sender(form_id, NEW)
    assert TestClient(app).post(f"/api/forms/{form_id}/approve").status_code == 200
    assert is_canonical(NEW, get_settings().senders)


def test_a_known_sender_is_not_added_twice(tmp_env):
    db.seed_config()
    _, form_id, ids = _seed_form(workflow="needs_fix", levels=("ok", "review"))
    assert TestClient(app).post(f"/api/fields/{ids[1]}/approve").status_code == 200  # "מכבי"
    assert not _audit("sender_added")
    assert canonical_names(get_settings().senders).count("מכבי") == 1


def test_correcting_the_sender_adds_it(tmp_env):
    db.seed_config()
    _, form_id, ids = _seed_form(workflow="needs_fix", levels=("ok", "review"))
    r = TestClient(app).patch(f"/api/fields/{ids[1]}", json={"value": NEW})
    assert r.status_code == 200
    assert is_canonical(NEW, get_settings().senders)


def test_a_corrected_department_adds_its_hospital_not_the_department(tmp_env):
    db.seed_config()
    _, form_id, ids = _seed_form(workflow="needs_fix", levels=("ok", "review"))
    r = TestClient(app).patch(f"/api/fields/{ids[1]}", json={"value": "מחלקת פנימית ב' ברוםנברג"})
    assert r.status_code == 200 and r.json()["value"] == "ברוםנברג"
    assert is_canonical("ברוםנברג", get_settings().senders)
    assert not is_canonical("מחלקת פנימית ב' ברוםנברג", get_settings().senders)


def test_a_department_of_a_listed_hospital_is_filed_under_the_hospital(tmp_env):
    db.seed_config()
    _, form_id, ids = _seed_form(workflow="needs_fix", levels=("ok", "review"))
    r = TestClient(app).patch(f"/api/fields/{ids[1]}", json={"value": "מחלקת פנימית ב' לניאדו"})
    assert r.json()["value"] == "לניאדו - מרכז רפואי צאנז"
    assert not _audit("sender_added")  # already in the list: nothing to add
