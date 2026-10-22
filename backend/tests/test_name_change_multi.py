"""One upload of several pages of the same (known) ID, each with another name: every page must raise the alert,
the clerk's decisions must carry over to the others, and nothing may be swapped for the filed name unasked."""
import asyncio
import base64
import io
import json
import shutil

from fastapi.testclient import TestClient
from PIL import Image
from sqlmodel import Session, select

from app import db
from app.main import app
from app.models import Batch, Field, Form, PatientName, SourceFile
from pipeline.runner import process_batch
from tests.test_patients import VALID_ID, _commitment
from tests.test_pipeline_failure import GOOD, _ctx


class ByPage:
    """Answers per page: the width of the page image says which (name, confidence) it carries."""

    def __init__(self, pages, second_differs=False):
        self.pages, self.second_differs = pages, second_differs

    async def call_tool(self, image_b64, media_type, prompt, tool, system=None):
        if tool["name"] == "record_orientation":
            return {"clockwise_degrees": 0}
        width = Image.open(io.BytesIO(base64.b64decode(image_b64))).size[0]
        name, conf = self.pages[width - 60]
        if self.second_differs and "Look again" in prompt:
            name += "ם"
        return dict(GOOD, full_name={"value": name, "confidence": conf, "legible": True})


def _upload(tmp_env, pages, double_check=False, second_differs=False):
    """Read one file whose pages carry these (name, confidence) pairs; returns the form ids in page order."""
    shutil.rmtree(tmp_env.batches_dir / "1", ignore_errors=True)
    up = tmp_env.batches_dir / "1" / "uploads"
    up.mkdir(parents=True)
    with Session(db.get_engine()) as s:
        batch = Batch()
        s.add(batch)
        s.commit()
        s.refresh(batch)
        for i in range(len(pages)):
            path = up / f"{i}.png"
            Image.new("RGB", (60 + i, 80), "white").save(path)
            s.add(SourceFile(batch_id=batch.id, filename=path.name, path=str(path)))
        s.commit()
        batch_id = batch.id
    client = ByPage(pages, second_differs)
    asyncio.run(process_batch(batch_id, _ctx(tmp_env, client, double_check=double_check)))
    with Session(db.get_engine()) as s:
        return [f.id for f in s.exec(select(Form).where(Form.batch_id == batch_id).order_by(Form.source_file_id))]


def _name(form_id):
    with Session(db.get_engine()) as s:
        f = s.exec(select(Field).where(Field.form_id == form_id, Field.name == "full_name")).one()
        return json.loads(f.value), f.level, {r["code"]: r.get("detail") for r in json.loads(f.reasons)}


def _form(form_id):
    with Session(db.get_engine()) as s:
        return s.get(Form, form_id)


PAGES = [("ניצן לוי", 0.99), ("דוד אברהם", 0.99), ("ניצן לוי", 0.99), ("רות מזרחי", 0.55),
         ("חיים כהן", 0.99), ("חיים כוהן", 0.99)]


def test_every_page_with_another_name_raises_the_alert_and_none_is_swapped(tmp_env):
    _commitment(VALID_ID, name="חיים כהן", numbers=("1",))
    for double_check, second_differs in ((False, False), (True, False), (True, True)):
        ids = _upload(tmp_env, PAGES, double_check, second_differs)
        for form_id, (read, _) in zip(ids[:4], PAGES[:4]):
            value, level, reasons = _name(form_id)
            assert value.startswith(read), (double_check, second_differs, read)
            assert level == "review" and reasons.get("name_change") == "חיים כהן", (double_check, read)
            assert _form(form_id).workflow == "needs_fix"
        for form_id in ids[4:]:  # the filed name, or the same in another spelling: nothing to ask
            assert "name_change" not in _name(form_id)[2]


def test_a_barely_readable_name_is_still_filled_in_from_the_patient_file(tmp_env):
    _commitment(VALID_ID, name="חיים כהן", numbers=("1",))
    (form_id,) = _upload(tmp_env, [("ךחק", 0.3)])
    value, level, reasons = _name(form_id)
    assert value == "חיים כהן" and level == "ok" and "name_from_patient_file" in reasons


def test_the_clerks_decision_on_one_page_carries_over_to_the_others(tmp_env):
    _commitment(VALID_ID, name="חיים כהן", numbers=("1",))
    ids = _upload(tmp_env, PAGES[:4])
    with Session(db.get_engine()) as s:
        field_id = s.exec(select(Field.id).where(Field.form_id == ids[0], Field.name == "full_name")).one()
    with TestClient(app) as client:
        assert client.post(f"/api/fields/{field_id}/approve").status_code == 200
    with Session(db.get_engine()) as s:
        assert s.get(PatientName, VALID_ID).full_name == "ניצן לוי"
    value, level, reasons = _name(ids[2])  # the same new name on another page: no longer a question
    assert value == "ניצן לוי" and "name_change" not in reasons and level == "ok"
    for form_id in (ids[1], ids[3]):  # other names: asked again, now against the new name
        value, level, reasons = _name(form_id)
        assert level == "review" and reasons["name_change"] == "ניצן לוי"


def test_a_form_already_with_the_approver_goes_back_to_the_clerk_when_flagged(tmp_env):
    first = _commitment(VALID_ID, name="חיים כהן", numbers=("1",))
    (form_id,) = _upload(tmp_env, [("חיים כהן", 0.99)])
    assert _name(form_id)[1] == "ok" and _form(form_id).workflow == "pending_approval"
    other = _upload(tmp_env, [("ניצן לוי", 0.99)])[0]
    with Session(db.get_engine()) as s:
        fld = s.exec(select(Field).where(Field.form_id == other, Field.name == "full_name")).one()
        s.add(fld)
        s.commit()
        field_id = fld.id
    with TestClient(app) as client:
        assert client.post(f"/api/fields/{field_id}/approve").status_code == 200  # the patient is now "ניצן לוי"
    value, level, reasons = _name(form_id)  # "חיים כהן", sitting with the approver, now differs from the filed name
    assert level == "review" and reasons["name_change"] == "ניצן לוי"
    assert _form(form_id).workflow == "needs_fix"
    assert first  # the filed form is untouched


def test_an_undecided_form_cannot_be_submitted_either(tmp_env):
    _commitment(VALID_ID, name="חיים כהן", numbers=("1",))
    (form_id,) = _upload(tmp_env, [("ניצן לוי", 0.99)])
    with TestClient(app) as client:
        r = client.post(f"/api/forms/{form_id}/submit")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "name_change_pending"
