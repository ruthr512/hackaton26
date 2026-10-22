"""A clear name that differs from the one filed under a trusted ID is a possible name change: the clerk decides.

Approved: the patient file takes the new name. Not approved: the form cannot be approved for export until a
corrected commitment replaces it or it is deleted.
"""
import asyncio
import json
import shutil

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app import db, identity
from app.main import app
from app.models import Field, Form, PatientName
from pipeline.runner import process_batch
from tests.test_patients import VALID_ID, _commitment
from tests.test_pipeline_failure import GOOD, StubClient, _ctx, _make_batch


def _scan(tmp_env, name, conf=1.0):
    """Read one new commitment of VALID_ID with this name, as the pipeline would; returns the form id."""
    resp = dict(GOOD, full_name={"value": name, "confidence": conf, "legible": True})
    shutil.rmtree(tmp_env.batches_dir / "1", ignore_errors=True)  # _make_batch always uses the folder "1"
    batch_id = _make_batch(tmp_env, n_files=1)
    asyncio.run(process_batch(batch_id, _ctx(tmp_env, StubClient(response=resp))))
    with Session(db.get_engine()) as s:
        return s.exec(select(Form).where(Form.batch_id == batch_id)).one().id


def _field(form_id, name):
    with Session(db.get_engine()) as s:
        return s.exec(select(Field).where(Field.form_id == form_id, Field.name == name)).one()


def _set_workflow(form_id, workflow):
    with Session(db.get_engine()) as s:
        fm = s.get(Form, form_id)
        fm.workflow = workflow
        s.add(fm)
        s.commit()


def _filed_name():
    with Session(db.get_engine()) as s:
        row = s.get(PatientName, VALID_ID)
        return (row.full_name, json.loads(row.previous_names)) if row else None


def test_different_name_is_flagged_however_sure_the_read_is(tmp_env):
    _commitment(VALID_ID, name="חיים כהן", numbers=("1",))
    form_id = _scan(tmp_env, "ניצן לוי", conf=1.0)
    name = _field(form_id, "full_name")
    assert name.level == "review" and name.value == '"ניצן לוי"'
    assert {"kind": "validation", "code": "name_change", "detail": "חיים כהן"} in json.loads(name.reasons)
    assert _filed_name() is None  # nothing changes until the clerk says so


def test_approving_the_flagged_name_renames_the_patient_and_frees_the_form(tmp_env):
    _commitment(VALID_ID, name="חיים כהן", numbers=("1",))
    form_id = _scan(tmp_env, "ניצן לוי")
    _set_workflow(form_id, "pending_approval")
    with TestClient(app) as client:
        r = client.post(f"/api/forms/{form_id}/approve")  # name not decided yet
        assert r.status_code == 409 and r.json()["detail"]["code"] == "name_change_pending"
        assert client.post(f"/api/fields/{_field(form_id, 'full_name').id}/approve").status_code == 200
        assert _filed_name() == ("ניצן לוי", ["חיים כהן"])
        assert client.post(f"/api/forms/{form_id}/approve").status_code == 200
        file = client.get(f"/api/patients/{VALID_ID}").json()
        assert file["name_change"]["current"] == "ניצן לוי" and file["name_change"]["previous"] == ["חיים כהן"]
        assert file["names"][0] == "ניצן לוי"
        assert client.get("/api/patients").json()[0]["name_changed"] is True


def test_after_the_change_the_new_name_is_normal_and_the_old_one_is_flagged(tmp_env):
    _commitment(VALID_ID, name="חיים כהן", numbers=("1",))
    first = _scan(tmp_env, "ניצן לוי")
    with TestClient(app) as client:
        client.post(f"/api/fields/{_field(first, 'full_name').id}/approve")
    same = _scan(tmp_env, "ניצן לוי")
    assert _field(same, "full_name").level == "ok"
    back = _scan(tmp_env, "חיים כהן")
    flagged = _field(back, "full_name")
    assert flagged.level == "review"
    assert {"kind": "validation", "code": "name_change", "detail": "ניצן לוי"} in json.loads(flagged.reasons)


def test_typing_back_the_filed_name_changes_nothing(tmp_env):
    _commitment(VALID_ID, name="חיים כהן", numbers=("1",))
    form_id = _scan(tmp_env, "ניצן לוי")
    with TestClient(app) as client:
        r = client.patch(f"/api/fields/{_field(form_id, 'full_name').id}", json={"value": "חיים כהן"})
        assert r.status_code == 200
    assert _filed_name() is None
    assert identity.open_name_change(Session(db.get_engine()), form_id) is None  # decided: no longer blocks


def test_undecided_form_is_skipped_by_bulk_and_finalize_and_can_be_deleted(tmp_env):
    _commitment(VALID_ID, name="חיים כהן", numbers=("1",))
    form_id = _scan(tmp_env, "ניצן לוי")
    _set_workflow(form_id, "pending_approval")
    with Session(db.get_engine()) as s:
        batch_id = s.get(Form, form_id).batch_id
    with TestClient(app) as client:
        r = client.post("/api/forms/approve-bulk", json={"ids": [form_id]}).json()
        assert r == {"approved": [], "skipped": [form_id]}
        r = client.post(f"/api/batches/{batch_id}/finalize").json()
        assert r["approved"] == [] and form_id in r["skipped"]
        assert client.delete(f"/api/forms/{form_id}").status_code == 200
    with Session(db.get_engine()) as s:
        assert s.get(Form, form_id) is None
        assert not s.exec(select(Field).where(Field.form_id == form_id)).all()


def test_same_name_in_another_spelling_is_no_name_change(tmp_env):
    _commitment(VALID_ID, name="דנה כהן", numbers=("1",))
    form_id = _scan(tmp_env, "דנה כוהן")
    assert _field(form_id, "full_name").level == "ok"


def _scan_double_checked(tmp_env, name, second_name):
    resp = dict(GOOD, full_name={"value": name, "confidence": 0.99, "legible": True})
    second = dict(GOOD, full_name={"value": second_name, "confidence": 0.99, "legible": True})
    shutil.rmtree(tmp_env.batches_dir / "1", ignore_errors=True)
    batch_id = _make_batch(tmp_env, n_files=1)
    asyncio.run(process_batch(batch_id, _ctx(tmp_env, StubClient(response=resp, second=second), double_check=True)))
    with Session(db.get_engine()) as s:
        return s.exec(select(Form).where(Form.batch_id == batch_id)).one().id


def test_a_second_read_never_swaps_the_new_name_for_the_filed_one(tmp_env):
    """The name was flagged when first read; the zoomed re-read that follows must not quietly undo it."""
    _commitment(VALID_ID, name="חיים כהן", numbers=("1",))
    for second_name in ("ניצן לוי", "ניצן לו", "נצן לוי"):
        form_id = _scan_double_checked(tmp_env, "ניצן לוי", second_name)
        name = _field(form_id, "full_name")
        assert name.value == '"ניצן לוי"', second_name
        assert name.level == "review" and "name_change" in name.reasons, second_name
        assert "name_from_patient_file" not in name.reasons


def test_a_flagged_name_survives_a_later_propagation_even_when_its_confidence_is_low(tmp_env):
    filed = _commitment(VALID_ID, name="חיים כהן", numbers=("1",))
    form_id = _scan_double_checked(tmp_env, "ניצן לוי", "ניצן לו")
    with Session(db.get_engine()) as s:
        fld = s.exec(select(Field).where(Field.form_id == form_id, Field.name == "full_name")).one()
        fld.confidence = 0.55  # doubtful, but still a name that was read
        s.add(fld)
        s.commit()
        identity.propagate(s, s.get(Form, filed))
        identity.propagate(s, s.get(Form, form_id))
    name = _field(form_id, "full_name")
    assert name.value == '"ניצן לוי"' and name.level == "review" and "name_change" in name.reasons
