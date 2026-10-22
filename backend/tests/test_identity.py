"""Identity rules: confident reads skip the clerk (>= 65%), a known ID fixes an unsure name, a clashing name is an error."""
import asyncio
import json

from sqlmodel import Session, select

from app import db, identity
from app.fields import LEVEL_EMPTY, LEVEL_OK, LEVEL_REVIEW
from app.models import Field, Form
from pipeline.base import FieldResult, FormDoc
from pipeline.runner import process_batch
from pipeline.stages.confidence import Policy, settle
from tests.test_patients import VALID_ID, _commitment, _form
from tests.test_pipeline_failure import GOOD, StubClient, _ctx, _fields, _make_batch

CFG = {"confidence": {"threshold": 0.65}, "identity": {"id_min_confidence": 0.70, "name_match": 75}}


def _doc(name, name_conf, id_value=VALID_ID, id_conf=0.9, name_legible=True):
    fields = {
        "full_name": FieldResult(value=name, confidence=name_conf, legible=name_legible, level=LEVEL_REVIEW),
        "id_number": FieldResult(value=id_value, confidence=id_conf, level=LEVEL_OK),
    }
    return FormDoc(batch_id=1, source_file_id=1, fields=fields)


def _reconcile(doc):
    with Session(db.get_engine()) as s:
        identity.reconcile(s, doc, None, CFG)
    return doc.fields["full_name"], doc.fields["id_number"]


def _level(conf, **kw):
    fr = FieldResult(value="x", confidence=conf, **kw)
    settle(fr, Policy())
    return fr.level


def test_confidence_bands_empty_review_ok():
    assert _level(0.49) == LEVEL_EMPTY
    assert _level(0.50) == LEVEL_REVIEW and _level(0.79) == LEVEL_REVIEW
    assert _level(0.80) == LEVEL_OK
    assert _level(0.95, handwritten=True) == LEVEL_REVIEW  # handwriting is never accepted on one read


def test_unsure_name_takes_the_name_filed_under_the_id(tmp_env):
    _commitment(VALID_ID, name="דנה כהן", numbers=("999",))
    for garbled, conf in (("דנח כחז", 0.3), (None, 0.0), ("דנה כהן-לוי מחובר", 0.45)):
        name, ident = _reconcile(_doc(garbled, conf))
        assert name.value == "דנה כהן" and name.level == LEVEL_OK
        assert {"kind": "info", "code": "name_from_patient_file"} in name.reasons
        assert not any(r["kind"] == "soft" for r in name.reasons)
        assert ident.level == LEVEL_OK


def test_unsure_name_is_kept_when_the_id_is_not_trusted_or_unknown(tmp_env):
    _commitment(VALID_ID, name="דנה כהן", numbers=("999",))
    name, _ = _reconcile(_doc("דנח", 0.3, id_conf=0.6))  # ID under 70%
    assert name.value == "דנח"
    name, _ = _reconcile(_doc("דנח", 0.3, id_value="123456789"))  # bad check digit
    assert name.value == "דנח"
    name, _ = _reconcile(_doc("דנח", 0.3, id_value="000000018"))  # nobody filed under it
    assert name.value == "דנח"


def test_clear_name_that_differs_from_the_filed_one_is_an_error(tmp_env):
    _commitment(VALID_ID, name="דנה כהן", numbers=("999",))
    name, ident = _reconcile(_doc("יוסי לוי", 0.9))
    assert name.value == "יוסי לוי"  # never overwritten: a person decides which is right
    for fr in (name, ident):
        assert fr.level == LEVEL_REVIEW
    assert {"kind": "validation", "code": "name_change", "detail": "דנה כהן"} in name.reasons  # says who it is filed as
    assert {"kind": "validation", "code": "id_name_conflict"} in ident.reasons


def test_same_name_spelled_differently_or_in_another_script_is_no_conflict(tmp_env):
    _commitment(VALID_ID, name="דנה כהן", numbers=("999",))
    for other in ("דנה כוהן", "כהן דנה", "Dana Cohen"):
        name, ident = _reconcile(_doc(other, 0.9))
        assert not any(r["code"] == "id_name_conflict" for r in name.reasons + ident.reasons), other
        assert name.value == other


def test_handwritten_clear_name_is_still_compared(tmp_env):
    """A handwritten name is always 'review' by level, yet read at 90% it is a clear read: a clash is an error."""
    _commitment(VALID_ID, name="דנה כהן", numbers=("999",))
    doc = _doc("יוסי לוי", 0.9)
    doc.fields["full_name"].handwritten = True
    name, _ = _reconcile(doc)
    assert any(r["code"] == "name_change" for r in name.reasons)


def test_pipeline_unsure_name_with_known_id_goes_straight_to_approval(tmp_env):
    _commitment(VALID_ID, name="דנה כהן", numbers=("999",))
    resp = dict(GOOD, full_name={"value": "דנח כחז", "confidence": 0.3, "legible": True})
    batch_id = _make_batch(tmp_env, n_files=1)
    asyncio.run(process_batch(batch_id, _ctx(tmp_env, StubClient(response=resp))))
    with Session(db.get_engine()) as s:
        form = s.exec(select(Form).where(Form.batch_id == batch_id)).one()
    assert _fields(form.id)["full_name"].value == '"דנה כהן"'
    assert form.workflow == "pending_approval"


def test_pipeline_name_clash_stays_with_the_clerk(tmp_env):
    _commitment(VALID_ID, name="דנה כהן", numbers=("999",))
    resp = dict(GOOD, full_name={"value": "יוסי לוי", "confidence": 0.95, "legible": True})
    batch_id = _make_batch(tmp_env, n_files=1)
    asyncio.run(process_batch(batch_id, _ctx(tmp_env, StubClient(response=resp))))
    with Session(db.get_engine()) as s:
        form = s.exec(select(Form).where(Form.batch_id == batch_id)).one()
    f = _fields(form.id)
    assert form.workflow == "needs_fix"
    assert "name_change" in f["full_name"].reasons and "id_name_conflict" in f["id_number"].reasons


def _stored(form_id, name, name_conf, level, id_reasons=(), touched=False, workflow="needs_fix"):
    """A form already in the system: a name and an ID read as given (the ID valid, read twice)."""
    with Session(db.get_engine()) as s:
        fm = s.get(Form, form_id)
        fm.workflow = workflow
        s.add(fm)
        for f in s.exec(select(Field).where(Field.form_id == form_id)).all():
            if f.name == "full_name":
                f.value, f.confidence, f.level = json.dumps(name, ensure_ascii=False), name_conf, level
                f.manually_corrected, f.version = touched, 1 if touched else 0
                f.reasons = json.dumps([{"kind": "soft", "code": "low_confidence"}] if level != "ok" else [])
            elif f.name == "id_number":
                f.confidence = 0.6
                f.reasons = json.dumps([{"kind": "soft", "code": c} for c in id_reasons]
                                       + [{"kind": "info", "code": "double_check_confirmed"}])
            s.add(f)
        s.commit()


def test_name_a_person_confirmed_reaches_the_other_forms_of_the_same_id(tmp_env):
    """Forms of one file are read together; the clerk fixes the first name only afterwards."""
    first = _commitment(VALID_ID, name="x", numbers=("1",))
    second = _commitment(VALID_ID, name="x", numbers=("2",))
    third = _commitment(VALID_ID, name="x", numbers=("3",))
    _stored(first, "ישראל ישראלי", 0.3, "ok", touched=True)  # the clerk typed it
    _stored(second, "ישרא׳ ישראבי", 0.2, "review")           # garbled
    _stored(third, "יוסי לוי", 0.9, "ok")                    # clearly another name
    with Session(db.get_engine()) as s:
        identity.propagate(s, s.get(Form, first))
    f2, f3 = _fields(second), _fields(third)
    assert f2["full_name"].value == '"ישראל ישראלי"' and f2["full_name"].level == "ok"
    assert "name_from_patient_file" in f2["full_name"].reasons
    assert _form(second).workflow == "needs_fix" or _form(second).workflow == "pending_approval"
    assert "name_change" in f3["full_name"].reasons and f3["full_name"].level == "review"
    assert f3["full_name"].value == '"יוסי לוי"'  # a clear read is flagged, never overwritten
    assert _fields(first)["full_name"].value == '"ישראל ישראלי"'  # the person's own edit is untouched


def test_propagation_skips_forms_a_person_already_worked_on_and_approved_ones(tmp_env):
    first = _commitment(VALID_ID, name="x", numbers=("1",))
    edited = _commitment(VALID_ID, name="x", numbers=("2",))
    approved = _commitment(VALID_ID, name="x", numbers=("3",))
    _stored(first, "ישראל ישראלי", 0.3, "ok", touched=True)
    _stored(edited, "אחר אחר", 0.2, "ok", touched=True)
    _stored(approved, "שם ישן", 0.2, "review", workflow="approved")
    with Session(db.get_engine()) as s:
        identity.propagate(s, s.get(Form, first))
    assert _fields(edited)["full_name"].value == '"אחר אחר"'
    assert _fields(approved)["full_name"].value == '"שם ישן"'



def test_clerk_correcting_a_name_updates_the_other_forms_through_the_api(tmp_env):
    from fastapi.testclient import TestClient
    from app.main import app

    first = _commitment(VALID_ID, name="x", numbers=("1",))
    second = _commitment(VALID_ID, name="x", numbers=("2",))
    _stored(first, "גרוע", 0.2, "review")
    _stored(second, "גרוע אחר", 0.2, "review")
    name_field = _fields(first)["full_name"]
    with TestClient(app) as client:
        r = client.patch(f"/api/fields/{name_field.id}", json={"value": "ישראל ישראלי"})
        assert r.status_code == 200
    f2 = _fields(second)["full_name"]
    assert f2.value == '"ישראל ישראלי"' and "name_from_patient_file" in f2.reasons
