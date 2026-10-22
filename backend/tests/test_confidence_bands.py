"""Confidence from evidence: under 50% empty ("not identified"), 50-80% review, from 80% automatic.

A model that says "1.0" for everything is not believed on its word: a disagreeing second read, a failed check digit,
or no second read at all (handwriting) bring the confidence down, whatever the model claimed.
"""
import asyncio
from types import SimpleNamespace

import pytest
from PIL import Image

from app.fields import LEVEL_EMPTY, LEVEL_OK, LEVEL_REVIEW
from pipeline.base import Context, FieldResult, FormDoc
from pipeline.readers import ClaudeReader, CrossCheckReader, ProviderConfigError, build_reader
from pipeline.stages.confidence import AGREE, DISAGREE, Check, Confidence, Policy, provisional, settle

GOOD_ID = "123456782"  # valid check digit


def _settle(fr, **kw):
    settle(fr, Policy(), **kw)
    return fr


def test_the_three_bands():
    assert _settle(FieldResult(value="x", confidence=0.49)).level == LEVEL_EMPTY
    assert _settle(FieldResult(value="x", confidence=0.50)).level == LEVEL_REVIEW
    assert _settle(FieldResult(value="x", confidence=0.799)).level == LEVEL_REVIEW
    assert _settle(FieldResult(value="x", confidence=0.80)).level == LEVEL_OK


def test_under_50_percent_the_value_is_dropped_and_says_not_identified():
    fr = _settle(FieldResult(value="דנה כהן", raw_value="דנה כהן", confidence=0.3,
                             reasons=[{"kind": "validation", "code": "invalid_id_checksum"}]))
    assert fr.value is None and fr.level == LEVEL_EMPTY
    assert fr.raw_value == "דנה כהן"  # what the model read stays, for the audit trail and the learning
    assert fr.reasons == [{"kind": "info", "code": "not_identified"}]  # nothing left to validate


def test_a_model_saying_100_percent_is_not_believed_when_the_second_read_disagrees():
    fr = _settle(FieldResult(value="x", confidence=1.0), check=Check(DISAGREE))
    assert fr.level == LEVEL_REVIEW and fr.confidence == pytest.approx(0.60)


def test_two_agreeing_reads_lift_the_confidence():
    fr = _settle(FieldResult(value="x", confidence=0.65), check=Check(AGREE, 0.65))
    assert fr.confidence == pytest.approx(0.80) and fr.level == LEVEL_OK
    fr = _settle(FieldResult(value="x", confidence=0.55), check=Check(AGREE, 0.55))
    assert fr.confidence == pytest.approx(0.70) and fr.level == LEVEL_REVIEW


def test_a_failed_check_digit_caps_a_confident_read():
    fr = _settle(FieldResult(value="123456789", confidence=1.0,
                             reasons=[{"kind": "validation", "code": "invalid_id_checksum"}]), check=Check(AGREE, 1.0))
    assert fr.confidence == pytest.approx(0.60) and fr.level == LEVEL_REVIEW


def test_a_business_hold_sends_to_review_without_touching_the_confidence():
    fr = _settle(FieldResult(value="מרפאה חדשה", confidence=0.95,
                             reasons=[{"kind": "validation", "code": "sender_not_in_list"}]))
    assert fr.level == LEVEL_REVIEW and fr.confidence == pytest.approx(0.95)


def test_a_provider_without_a_confidence_starts_from_neutral_and_needs_agreement():
    fr = _settle(FieldResult(value="x", confidence=1.0), reports=False)  # Gemini sets a constant 1.0
    assert fr.level == LEVEL_REVIEW and fr.confidence == pytest.approx(0.70)
    fr = _settle(FieldResult(value="x", confidence=1.0), reports=False, check=Check(AGREE, 1.0, reports=False))
    assert fr.level == LEVEL_OK and fr.confidence == pytest.approx(0.85)


def test_an_unreadable_flag_caps_the_confidence():
    fr = _settle(FieldResult(value="x", confidence=1.0, legible=False))
    assert fr.level == LEVEL_REVIEW and fr.confidence == pytest.approx(0.70)


def test_policy_reads_the_config_and_ignores_unknown_keys():
    p = Policy.from_cfg({"confidence": {"empty_below": 0.4, "review_below": 0.9, "threshold": 0.65}})
    assert (p.empty_below, p.review_below, p.agree_bonus) == (0.4, 0.9, 0.15)


# ---------- the stage ----------

class Stub:
    def __init__(self, answers):
        self.answers = answers  # field name -> the second read

    async def call_tool(self, image_b64, media_type, prompt, tool, system=None):
        (name,) = tool["input_schema"]["properties"]
        return {name: self.answers[name]}


def _page(tmp_path):
    p = tmp_path / "page.png"
    Image.new("RGB", (1000, 1400), "white").save(p)
    return str(p)


def _run(tmp_path, fields, answers, double_check=True):
    form = FormDoc(batch_id=0, source_file_id=0, image_path=_page(tmp_path), fields=fields)
    ctx = Context(settings=None, client=Stub(answers), senders_cfg={},
                  pipeline_cfg={"double_check": {"enabled": double_check, "scope": "all"}})
    return asyncio.run(Confidence().run(form, ctx)).fields


def _fr(value, conf=1.0, **kw):
    return FieldResult(value=value, raw_value=value, confidence=conf, box=[0.1, 0.1, 0.4, 0.14], **kw)


def test_every_value_is_read_twice_and_a_wrong_100_percent_goes_to_a_person(tmp_path):
    fields = {"full_name": _fr("דנה כהן"), "receipt_date": _fr("2024-03-05"), "sender": _fr("מכבי")}
    out = _run(tmp_path, fields, {
        "full_name": {"value": "דנה כהן", "confidence": 0.95, "legible": True},
        "receipt_date": {"value": "2024-03-06", "confidence": 0.9, "legible": True},  # the model's 100% was wrong
        "sender": {"value": None, "confidence": 0.0, "legible": False},  # the second read cannot see it
    })
    assert out["full_name"].level == LEVEL_OK
    assert out["receipt_date"].level == LEVEL_REVIEW and out["receipt_date"].confidence < 0.8
    assert out["sender"].level == LEVEL_REVIEW
    assert any(r["code"] == "double_check_disagree" for r in out["receipt_date"].reasons)


def test_a_low_confidence_read_the_second_read_cannot_confirm_is_left_empty(tmp_path):
    out = _run(tmp_path, {"full_name": _fr("ישרא", conf=0.4)},
               {"full_name": {"value": "ישראל", "confidence": 0.9, "legible": True}})
    assert out["full_name"].value is None and out["full_name"].level == LEVEL_EMPTY
    assert any(r["code"] == "not_identified" for r in out["full_name"].reasons)


def test_a_second_read_that_cannot_make_it_out_is_not_a_confirmation(tmp_path):
    out = _run(tmp_path, {"full_name": _fr("דנה כהן")},
               {"full_name": {"value": "דנה כהן", "confidence": 0.9, "legible": False}})
    assert out["full_name"].level == LEVEL_REVIEW
    assert not any(r["code"] == "double_check_confirmed" for r in out["full_name"].reasons)


def test_provisional_levels_accept_nothing_and_drop_nothing_while_a_second_read_is_coming(tmp_path):
    form = FormDoc(batch_id=0, source_file_id=0, image_path=_page(tmp_path),
                   fields={"full_name": _fr("דנה כהן"), "sender": _fr("מכבי", conf=0.2)})
    ctx = Context(settings=None, client=None, senders_cfg={}, pipeline_cfg={"double_check": {"enabled": True}})
    provisional(form, ctx)
    assert form.fields["full_name"].level == LEVEL_REVIEW and form.fields["full_name"].confidence < 0.8
    assert form.fields["sender"].value == "מכבי" and form.fields["sender"].level == LEVEL_REVIEW


# ---------- more than one model ----------

def test_a_cross_check_reader_reads_with_one_model_and_verifies_with_another():
    gemini = SimpleNamespace(tighten_boxes=False, reports_confidence=False, check_reports_confidence=False,
                             crop_margin=0.0, box_pad=0.1, same=lambda n, a, b: a == b)
    reader = CrossCheckReader(ClaudeReader(), gemini)
    assert reader.recheck_all and reader.tighten_boxes and reader.reports_confidence
    assert not reader.check_reports_confidence and reader.box_pad == 0.1


def test_build_reader_cross_checks_when_a_different_verifier_is_configured():
    s = SimpleNamespace(gemini_api_key="k", gemini_model="m", ssl_cert_file="")
    reader = build_reader(s, {"provider": "claude", "verifier": "gemini"})
    assert isinstance(reader, CrossCheckReader) and isinstance(reader.primary, ClaudeReader)
    assert isinstance(build_reader(s, {"provider": "claude", "verifier": None}), ClaudeReader)
    assert isinstance(build_reader(s, {"provider": "claude", "verifier": "claude"}), ClaudeReader)
    with pytest.raises(ProviderConfigError):
        build_reader(SimpleNamespace(gemini_api_key="", gemini_model="", ssl_cert_file=""),
                     {"provider": "claude", "verifier": "gemini"})


def test_an_old_stored_pipeline_gets_the_bands_once(tmp_env):
    import json

    from sqlmodel import Session

    from app import db
    from app.models import ConfigEntry

    old = {"confidence": {"threshold": 0.7, "handwriting_threshold": 0.8}, "double_check": {"enabled": True}}
    with Session(db.get_engine()) as s:
        s.add(ConfigEntry(name="pipeline", data=json.dumps(old)))
        s.commit()
    db.migrate_confidence_bands()
    with Session(db.get_engine()) as s:
        data = json.loads(s.get(ConfigEntry, "pipeline").data)
    assert data["confidence"]["empty_below"] == 0.5 and data["confidence"]["review_below"] == 0.8
    assert "threshold" not in data["confidence"] and data["identity"]["name_min_confidence"] == 0.7
    assert data["double_check"]["scope"] == "all"
    data["confidence"]["review_below"] = 0.9  # a manager's later edit survives a second start
    with Session(db.get_engine()) as s:
        s.get(ConfigEntry, "pipeline").data = json.dumps(data)
        s.commit()
    db.migrate_confidence_bands()
    with Session(db.get_engine()) as s:
        assert json.loads(s.get(ConfigEntry, "pipeline").data)["confidence"]["review_below"] == 0.9
