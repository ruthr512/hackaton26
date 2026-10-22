"""Handwriting: never ok after one read; zoomed crops confirm values or recover empty names/IDs."""
import asyncio
import base64
import io

from PIL import Image

from pipeline.base import Context, FieldResult, FormDoc
from pipeline.crops import crop_b64, halves_b64
from pipeline.stages.confidence import Confidence


class Stub:
    def __init__(self, second):
        self.second = second
        self.calls = []

    async def call_tool(self, image_b64, media_type, prompt, tool, system=None):
        self.calls.append((media_type, list(tool["input_schema"]["properties"])))
        return self.second


def _page(tmp_path):
    p = tmp_path / "page.png"
    Image.new("RGB", (1000, 1400), "white").save(p)
    return str(p)


def _ctx(client):
    return Context(settings=None, client=client, senders_cfg={},
                   pipeline_cfg={"confidence": {"threshold": 0.65}, "double_check": {"enabled": True}})


def _run(form, client):
    return asyncio.run(Confidence().run(form, _ctx(client)))


def _size(b64):
    with Image.open(io.BytesIO(base64.b64decode(b64))) as im:
        return im.size


def test_crop_upscales_small_box_and_needs_a_box(tmp_path):
    page = _page(tmp_path)
    w, h = _size(crop_b64(page, [0.6, 0.7, 0.8, 0.72]))
    assert w >= 1000 and h > 0
    assert crop_b64(page, None) is None
    assert [_size(x)[0] for x in halves_b64(page)] == [1000, 1000]


def test_handwriting_is_never_ok_after_one_read_printed_is_ok_from_80_percent(tmp_path):
    def level(conf, handwritten):
        form = FormDoc(batch_id=0, source_file_id=0, image_path=_page(tmp_path), fields={
            "full_name": FieldResult(value="ישראל ישראלי", confidence=conf, handwritten=handwritten)})
        ctx = _ctx(None)
        ctx.pipeline_cfg["double_check"]["enabled"] = False
        return asyncio.run(Confidence().run(form, ctx)).fields["full_name"]

    assert level(0.80, handwritten=False).level == "ok"
    hand = level(0.99, handwritten=True)
    assert hand.level == "review" and any(r["code"] == "handwritten" for r in hand.reasons)


def test_crop_agreement_upgrades_handwritten_to_ok(tmp_path):
    form = FormDoc(batch_id=0, source_file_id=0, image_path=_page(tmp_path), fields={
        "full_name": FieldResult(value="ישראל ישראלי", confidence=0.7, handwritten=True,
                                 box=[0.6, 0.7, 0.8, 0.72])})
    client = Stub({"full_name": {"value": "ישראל  ישראלי", "confidence": 0.9, "legible": True}})
    out = _run(form, client)
    assert out.fields["full_name"].level == "ok"  # (0.7 + 0.9) / 2 + 0.15 = 0.95
    assert client.calls == [("image/jpeg", ["full_name"])]  # one zoomed crop, one field


def test_empty_name_recovered_on_zoom_is_review_never_ok(tmp_path):
    form = FormDoc(batch_id=0, source_file_id=0, image_path=_page(tmp_path), fields={
        "full_name": FieldResult(value=None, box=[0.6, 0.7, 0.8, 0.72])})
    client = Stub({"full_name": {"value": "ישראל ישראלי", "confidence": 0.99, "legible": True}})
    f = _run(form, client).fields["full_name"]
    assert f.value == "ישראל ישראלי" and f.level == "review" and f.confidence < 0.80
    assert any(r["code"] == "recovered_on_zoom" for r in f.reasons)


def test_recovered_id_is_normalized_and_validated(tmp_path):
    form = FormDoc(batch_id=0, source_file_id=0, image_path=_page(tmp_path), fields={
        "id_number": FieldResult(value=None)})  # no box: page halves are read
    client = Stub({"id_number": {"value": "011223344", "confidence": 0.99, "legible": True}})
    f = _run(form, client).fields["id_number"]
    assert f.value == "11223344" and f.level == "review"
    assert len(client.calls) == 2
    assert not any(r["code"] == "invalid_id_checksum" for r in f.reasons)


def test_empty_field_stays_empty_when_zoom_finds_nothing(tmp_path):
    form = FormDoc(batch_id=0, source_file_id=0, image_path=_page(tmp_path), fields={
        "full_name": FieldResult(value=None, box=[0.1, 0.1, 0.3, 0.12])})
    f = _run(form, Stub({"full_name": {"value": None, "confidence": 0, "legible": False}})).fields["full_name"]
    assert f.value is None and f.level == "empty" and not f.reasons


# ---------- localize: frames are tightened on a crop and dropped unless verified ----------

def _localize(form, second, enabled=True):
    from pipeline.stages.localize import Localize
    ctx = _ctx(Stub(second))
    ctx.pipeline_cfg["localize"] = {"enabled": enabled, "margin": 0.0}
    return asyncio.run(Localize().run(form, ctx)).fields["full_name"]


def test_localize_maps_verified_crop_box_back_to_page(tmp_path):
    form = FormDoc(batch_id=0, source_file_id=0, image_path=_page(tmp_path), fields={
        "full_name": FieldResult(value="ישראל ישראלי", box=[0.2, 0.4, 0.6, 0.5], hint_box=[0.2, 0.4, 0.6, 0.5])})
    f = _localize(form, {"full_name": {"value": "ישראל ישראלי", "confidence": 1, "box": [0.25, 0.2, 0.75, 0.8]}})
    assert f.box == [0.3, 0.42, 0.5, 0.48] and f.box_verified  # crop covers x 0.2-0.6, y 0.4-0.5
    assert f.hint_box == [0.2, 0.4, 0.6, 0.5]


def test_localize_keeps_coarse_box_unverified_when_value_not_found_in_it(tmp_path):
    form = FormDoc(batch_id=0, source_file_id=0, image_path=_page(tmp_path), fields={
        "full_name": FieldResult(value="ישראל ישראלי", box=[0.2, 0.4, 0.6, 0.5], hint_box=[0.2, 0.4, 0.6, 0.5])})
    f = _localize(form, {"full_name": {"value": "דנה כהן", "confidence": 1, "box": [0.1, 0.1, 0.9, 0.5]}})
    assert f.box == [0.2, 0.4, 0.6, 0.5] and not f.box_verified


def test_localize_rejects_box_that_covers_the_whole_crop(tmp_path):
    form = FormDoc(batch_id=0, source_file_id=0, image_path=_page(tmp_path), fields={
        "full_name": FieldResult(value="א", box=[0.2, 0.4, 0.6, 0.5], hint_box=[0.2, 0.4, 0.6, 0.5])})
    f = _localize(form, {"full_name": {"value": "א", "box": [0, 0, 1, 1]}})
    assert (f.box, f.box_verified) == ([0.2, 0.4, 0.6, 0.5], False)


def test_localize_disabled_still_draws_coarse_frames_unverified(tmp_path):
    form = FormDoc(batch_id=0, source_file_id=0, image_path=_page(tmp_path), fields={
        "full_name": FieldResult(value="א", box=[0.2, 0.4, 0.6, 0.5], hint_box=[0.2, 0.4, 0.6, 0.5])})
    f = _localize(form, {}, enabled=False)
    assert f.box == [0.2, 0.4, 0.6, 0.5] and not f.box_verified


# ---------- orientation: sideways pages are turned upright before extraction ----------

def test_classify_rotates_sideways_page_upright(tmp_path):
    from pipeline.stages.classify import Classify
    p = tmp_path / "wide.png"
    Image.new("RGB", (1400, 1000), "white").save(p)  # a portrait form scanned lying down
    form = FormDoc(batch_id=0, source_file_id=0, image_path=str(p))
    ctx = _ctx(Stub({"clockwise_degrees": 90}))
    out = asyncio.run(Classify().run(form, ctx))
    assert out.form_type == "commitment"
    with Image.open(p) as im:
        assert im.size == (1000, 1400)


def test_classify_leaves_upright_or_failed_check_untouched(tmp_path):
    from pipeline.stages.classify import Classify
    p = tmp_path / "ok.png"
    Image.new("RGB", (1000, 1400), "white").save(p)
    for client in (Stub({"clockwise_degrees": 0}), Stub({}), object()):  # object(): call_tool raises
        form = FormDoc(batch_id=0, source_file_id=0, image_path=str(p))
        asyncio.run(Classify().run(form, _ctx(client)))
        with Image.open(p) as im:
            assert im.size == (1000, 1400)
