"""Gemini provider: box conversion, crops with 10% padding, comparison of the two reads, structured-output checks,
retries / errors of the REST client, provider choice from configuration, and the stages driven by a Gemini reader."""
import asyncio
import json
import logging
from types import SimpleNamespace

import pytest
from PIL import Image

from pipeline.base import Context, FieldResult, FormDoc
from pipeline.claude_client import ApiUnavailable
from pipeline.crops import pad_box
from pipeline.gemini import (GeminiClient, GeminiError, GeminiReader, GeminiRequestRejected, InvalidModelResponse,
                             box_from_2d, check_field, check_page, field_schema, page_schema, to_field_result)
from pipeline.normalizers import same_reading
from pipeline.readers import ClaudeReader, ProviderConfigError, build_reader, reader_of
from pipeline.stages.confidence import Confidence
from pipeline.stages.localize import Localize

GOOD_ID = "123456782"


def field(value, legible=True, script="printed", box=None):
    return {"value": value, "script": script, "legible": legible, "box_2d": box}


def page(**overrides):
    base = {
        "full_name": field("ישראל ישראלי", script="handwritten", box=[100, 200, 120, 400]),
        "id_number": field(GOOD_ID, script="handwritten", box=[200, 200, 220, 400]),
        "central_numbers": field([{"label": "מס' דגימה", "value": "55"}, {"label": None, "value": "56"}]),
        "receipt_date": field("2024-03-05"),
        "sender": field("כללית"),
        "commitment_numbers": field(["777"]),
        "test_type": field(None, legible=False),
        "referral_number": field(None, legible=False),
    }
    base.update(overrides)
    return base


# ---------- pure units ----------

def test_box_2d_is_y_first_on_a_1000_scale():
    assert box_from_2d([100, 200, 300, 400]) == [0.2, 0.1, 0.4, 0.3]  # ymin, xmin, ymax, xmax -> x0, y0, x1, y1
    assert box_from_2d(None) is None
    assert box_from_2d([300, 400, 100, 200]) is None  # inverted: not repaired, not drawn
    assert box_from_2d([0, 0, 1500, 1500]) == [0.0, 0.0, 1.0, 1.0]  # clamped to the page


def test_pad_box_adds_ten_percent_of_the_box_and_stays_on_the_page():
    x0, y0, x1, y1 = pad_box([0.4, 0.4, 0.6, 0.5], 0.10)
    assert (round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4)) == (0.38, 0.39, 0.62, 0.51)
    assert pad_box([0.0, 0.0, 1.0, 1.0], 0.10) == [0.0, 0.0, 1.0, 1.0]
    assert pad_box([0.95, 0.9, 1.0, 0.95], 0.10)[2:] == [1.0, 0.955]


def test_same_reading_ignores_spaces_and_hyphens_in_ids_and_numbers_only():
    assert same_reading("id_number", "123456782", "123-456 782")
    assert same_reading("commitment_numbers", ["12-34", "5 6"], ["1234", "56"])
    assert not same_reading("commitment_numbers", ["1234"], ["1243"])
    assert not same_reading("full_name", "דנה כהן", "דנה-כהן")
    assert not same_reading("id_number", "123456782", None)
    assert same_reading("id_number", None, None)


def test_field_checks_reject_what_the_schema_forbids():
    check_page(page())
    for bad in (
        field("x", script="cursive"),
        {**field("x"), "legible": "yes"},
        {**field("x"), "box_2d": [1, 2, 3]},
        {k: v for k, v in field("x").items() if k != "box_2d"},
        field(["x"]),  # a list for a single-value field
    ):
        with pytest.raises(ValueError):
            check_field("full_name", bad, True)
    with pytest.raises(ValueError):
        check_field("commitment_numbers", field("7"), True)
    with pytest.raises(ValueError):
        check_page({k: v for k, v in page().items() if k != "sender"})
    check_field("full_name", {"value": None, "script": "printed", "legible": False}, False)  # crop: no box key


def test_schemas_use_structured_output_types():
    schema = page_schema()
    assert set(schema["required"]) == set(schema["properties"])
    assert field_schema("full_name", False)["properties"].keys() == {"value", "script", "legible"}
    assert field_schema("central_numbers", True)["properties"]["value"]["items"]["type"] == "OBJECT"


def test_field_result_mapping():
    name = to_field_result("full_name", field(" ישראל ישראלי ", script="handwritten", box=[100, 200, 120, 400]))
    assert name.value == "ישראל ישראלי" and name.handwritten and name.box == name.hint_box == [0.2, 0.1, 0.4, 0.12]
    assert name.confidence == 1.0 and name.reasons == []

    numbers = to_field_result("central_numbers", field([{"label": "a", "value": "55"}, {"label": None, "value": " "}]))
    assert numbers.value == ["55"]  # the label is only a hint for the model

    unclear = to_field_result("receipt_date", field("03/04/24", legible=False))
    assert unclear.value == "03/04/24" and unclear.confidence == 0.0
    assert unclear.reasons == [{"kind": "validation", "code": "illegible"}]  # agreement of two reads cannot clear it

    empty = to_field_result("test_type", field(None, legible=False))
    assert empty.value is None and empty.reasons == []  # absent / unreadable stays "empty", like the other provider


# ---------- the REST client ----------

def envelope(obj, finish="STOP"):
    return json.dumps({"candidates": [{"content": {"parts": [{"text": json.dumps(obj)}]}, "finishReason": finish}]}).encode()


class Sender:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    def __call__(self, url, headers, body, timeout):
        self.calls.append((url, headers, json.loads(body)))
        return self.replies.pop(0)


def ok(obj):
    return 200, {}, envelope(obj)


def client_with(*replies, max_retries=2):
    send = Sender(*replies)
    return GeminiClient(api_key="KEY123", model="models/some-model", max_retries=max_retries, base_delay=0, send=send), send


def generate(client, check=None):
    return asyncio.run(client.generate("b64", "image/jpeg", "prompt", {"type": "OBJECT"}, system="SYS", check=check, tag="t"))


def test_request_shape_and_key_in_header_only():
    client, send = client_with(ok({"a": 1}))
    assert generate(client) == {"a": 1}
    url, headers, body = send.calls[0]
    assert url.endswith("/models/some-model:generateContent") and "KEY123" not in url
    assert headers["x-goog-api-key"] == "KEY123"
    assert body["generationConfig"] == {"responseMimeType": "application/json", "responseSchema": {"type": "OBJECT"}}
    assert body["systemInstruction"]["parts"][0]["text"] == "SYS"
    assert body["contents"][0]["parts"][0]["inlineData"] == {"mimeType": "image/jpeg", "data": "b64"}


def test_transient_errors_are_retried_then_raised():
    client, send = client_with((503, {}, b""), (429, {"Retry-After": "0"}, b""), ok({"a": 1}))
    assert generate(client) == {"a": 1} and len(send.calls) == 3
    client, send = client_with((503, {}, b""), (503, {}, b""), (503, {}, b""))
    with pytest.raises(GeminiError):
        generate(client)
    assert len(send.calls) == 3  # first try + 2 retries


def test_invalid_json_or_schema_mismatch_is_an_error_not_a_result(caplog):
    caplog.set_level(logging.INFO)
    secret = "TOP-SECRET-NAME"
    broken = (200, {}, json.dumps({"candidates": [{"content": {"parts": [{"text": "{" + secret}]},
                                                    "finishReason": "STOP"}]}).encode())
    client, _ = client_with(broken, broken, broken)
    with pytest.raises(InvalidModelResponse):
        generate(client)

    wrong = ok({"full_name": secret})
    client, _ = client_with(wrong, wrong, wrong)

    def check(out):
        raise ValueError("full_name: not an object")

    with pytest.raises(InvalidModelResponse):
        generate(client, check=check)
    assert secret not in caplog.text

    cut = (200, {}, envelope({"a": 1}, finish="MAX_TOKENS"))
    client, _ = client_with(cut, cut, cut)
    with pytest.raises(InvalidModelResponse):
        generate(client)


def test_a_retry_after_a_bad_answer_can_succeed():
    client, send = client_with((200, {}, b"not json"), ok({"a": 1}))
    assert generate(client) == {"a": 1} and len(send.calls) == 2


def test_auth_problems_pause_the_batch_and_bad_requests_are_not_retried():
    for reply in ((403, {}, b""), (401, {}, b""), (400, {}, b'{"error": {"details": [{"reason": "API_KEY_INVALID"}]}}')):
        client, send = client_with(reply)
        with pytest.raises(ApiUnavailable):
            generate(client)
        assert len(send.calls) == 1
    client, send = client_with((400, {}, b'{"error": {"message": "bad schema"}}'))
    with pytest.raises(GeminiRequestRejected):
        generate(client)
    assert len(send.calls) == 1


def test_an_unreachable_api_is_unavailable():
    from pipeline.gemini import _Unreachable

    def down(url, headers, body, timeout):
        raise _Unreachable(False)

    client = GeminiClient(api_key="k", model="m", max_retries=1, base_delay=0, send=down)
    with pytest.raises(ApiUnavailable):
        generate(client)


# ---------- provider choice ----------

def settings(**kw):
    return SimpleNamespace(**{"gemini_api_key": "", "gemini_model": "", "ssl_cert_file": "", **kw})


def test_claude_is_the_default_provider():
    assert isinstance(build_reader(settings(), {}), ClaudeReader)
    assert isinstance(build_reader(settings(), {"provider": "claude"}), ClaudeReader)
    assert isinstance(reader_of(Context(settings=None, pipeline_cfg={}, senders_cfg={}, client=None)), ClaudeReader)


def test_gemini_needs_key_and_model_from_the_environment():
    with pytest.raises(ProviderConfigError) as e:
        build_reader(settings(), {"provider": "gemini"})
    assert "GEMINI_API_KEY" in str(e.value) and "GEMINI_MODEL" in str(e.value)
    with pytest.raises(ProviderConfigError) as e:
        build_reader(settings(gemini_api_key="k"), {"provider": "gemini"})
    assert "GEMINI_MODEL" in str(e.value) and "GEMINI_API_KEY" not in str(e.value)
    reader = build_reader(settings(gemini_api_key="k", gemini_model="models/m"), {"provider": "Gemini"})
    assert isinstance(reader, GeminiReader) and reader.client.model == "m"
    with pytest.raises(ProviderConfigError):
        build_reader(settings(), {"provider": "other"})


# ---------- the stages with a Gemini reader ----------

class FakeGemini:
    """Stands in for GeminiClient: answers each call from `replies` (by field for crops, 'page' for the page)."""

    def __init__(self, replies):
        self.replies = replies
        self.tags = []

    async def generate(self, image_b64, media_type, prompt, schema, system=None, check=None, tag=""):
        self.tags.append(tag)
        reply = self.replies["page" if tag == "extract" else tag.split(":")[1]]
        if isinstance(reply, Exception):
            raise reply
        if check:
            check(reply)
        return reply


def crop_reply(value, legible=True):
    return {"value": value, "script": "handwritten", "legible": legible}


def gemini_ctx(replies):
    client = FakeGemini(replies)
    ctx = Context(settings=None, client=object(), senders_cfg={},
                  pipeline_cfg={"double_check": {"enabled": True}, "localize": {"enabled": True, "margin": 0.06}},
                  extras={"reader": GeminiReader(client)})
    return ctx, client


def page_file(tmp_path):
    p = tmp_path / "page.png"
    Image.new("RGB", (1000, 1400), "white").save(p)
    return str(p)


def test_page_read_gives_results_for_all_fields(tmp_path):
    ctx, client = gemini_ctx({"page": page()})
    out = asyncio.run(reader_of(ctx).read_page(ctx, page_file(tmp_path)))
    assert list(out) == ["full_name", "id_number", "central_numbers", "receipt_date", "sender",
                         "commitment_numbers", "test_type", "referral_number"]
    assert out["central_numbers"].value == ["55", "56"] and out["receipt_date"].value == "2024-03-05"
    assert client.tags == ["extract"]


def read_fields(**kw):
    """Fields as the Gemini page read leaves them: the box is also the hint box."""
    fields = {
        "full_name": FieldResult(value="ישראל ישראלי", confidence=1.0, handwritten=True, box=[0.2, 0.1, 0.4, 0.12]),
        "id_number": FieldResult(value=GOOD_ID, confidence=1.0, handwritten=True, box=[0.2, 0.2, 0.4, 0.22]),
        "sender": FieldResult(value="כללית", confidence=1.0, box=[0.2, 0.3, 0.4, 0.32]),
        **kw,
    }
    for fr in fields.values():
        fr.hint_box = fr.box
    return fields


def test_second_read_covers_every_field_and_agreement_or_not_decides(tmp_path):
    ctx, client = gemini_ctx({
        "full_name": crop_reply("ישראל  ישראלי"),
        "id_number": crop_reply("123-456-782"),  # hyphens are not a disagreement
        "sender": crop_reply("מכבי"),
    })
    form = FormDoc(batch_id=0, source_file_id=0, image_path=page_file(tmp_path), fields=read_fields())
    out = asyncio.run(Confidence().run(form, ctx)).fields
    assert sorted(client.tags) == ["double_check:full_name", "double_check:id_number", "double_check:sender"]
    assert out["full_name"].level == "ok" and out["id_number"].level == "ok"
    assert out["sender"].level == "review"
    assert any(r["code"] == "double_check_disagree" for r in out["sender"].reasons)


def test_a_failed_checksum_stays_in_review_even_when_both_reads_agree(tmp_path):
    bad = FieldResult(value="123456783", confidence=1.0, box=[0.2, 0.2, 0.4, 0.22],
                      reasons=[{"kind": "validation", "code": "invalid_id_checksum"}])
    ctx, _ = gemini_ctx({"id_number": crop_reply("123456783")})
    form = FormDoc(batch_id=0, source_file_id=0, image_path=page_file(tmp_path), fields={"id_number": bad})
    f = asyncio.run(Confidence().run(form, ctx)).fields["id_number"]
    assert f.level == "review" and any(r["code"] == "invalid_id_checksum" for r in f.reasons)


def test_an_illegible_value_stays_in_review_when_the_second_read_agrees(tmp_path):
    unclear = to_field_result("receipt_date", field("03/04/24", legible=False, box=[100, 200, 120, 400]))
    ctx, _ = gemini_ctx({"receipt_date": crop_reply("03/04/24", legible=False)})
    form = FormDoc(batch_id=0, source_file_id=0, image_path=page_file(tmp_path), fields={"receipt_date": unclear})
    f = asyncio.run(Confidence().run(form, ctx)).fields["receipt_date"]
    assert f.level == "review" and any(r["code"] == "illegible" for r in f.reasons)


def test_a_failed_second_read_never_leaves_a_value_ok(tmp_path):
    ctx, _ = gemini_ctx({"full_name": InvalidModelResponse("bad"), "id_number": crop_reply(GOOD_ID),
                         "sender": crop_reply("כללית")})
    form = FormDoc(batch_id=0, source_file_id=0, image_path=page_file(tmp_path), fields=read_fields())
    out = asyncio.run(Confidence().run(form, ctx)).fields
    assert out["full_name"].level == "review"
    assert any(r["code"] == "double_check_failed" for r in out["full_name"].reasons)
    assert out["id_number"].level == "ok"


def test_the_page_boxes_are_kept_without_a_separate_localize_read(tmp_path):
    ctx, client = gemini_ctx({})
    form = FormDoc(batch_id=0, source_file_id=0, image_path=page_file(tmp_path), fields=read_fields())
    out = asyncio.run(Localize().run(form, ctx)).fields["full_name"]
    assert client.tags == [] and out.box == [0.2, 0.1, 0.4, 0.12] and out.box_verified is False


# ---------- quota used up (429 that waiting does not cure) ----------

DAILY_QUOTA = json.dumps({"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "details": [
    {"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [{
        "quotaMetric": "generativelanguage.googleapis.com/generate_requests_per_model_per_day",
        "quotaId": "GenerateRequestsPerDayPerProjectPerModel"}]},
    {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "61250s"}]}}).encode()
PER_MINUTE = json.dumps({"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "details": [
    {"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [{
        "quotaMetric": "generativelanguage.googleapis.com/generate_requests_per_model_per_minute",
        "quotaId": "GenerateRequestsPerMinutePerProjectPerModel"}]},
    {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "12s"}]}}).encode()


def test_a_used_up_daily_quota_is_not_retried_and_later_calls_do_not_even_ask():
    from pipeline.gemini import GeminiQuotaExhausted

    client, send = client_with((429, {}, DAILY_QUOTA), ok({"a": 1}), max_retries=4)
    with pytest.raises(GeminiQuotaExhausted) as e:
        generate(client)
    assert len(send.calls) == 1 and e.value.retry_in == 61250 and isinstance(e.value, ApiUnavailable)
    assert client.quota_exhausted()
    with pytest.raises(GeminiQuotaExhausted):
        generate(client)
    assert len(send.calls) == 1  # refused locally, nothing sent


def test_a_per_minute_429_is_still_just_waited_out():
    client, send = client_with((429, {}, PER_MINUTE), ok({"a": 1}))
    assert generate(client) == {"a": 1} and len(send.calls) == 2
    assert not client.quota_exhausted()


class _Claude:
    tighten_boxes, recheck_all, crop_margin, box_pad = True, False, 0.03, 0.0
    reports_confidence = check_reports_confidence = True

    def __init__(self):
        self.pages = self.crops = 0

    async def read_page(self, ctx, image_path):
        self.pages += 1
        return {"full_name": FieldResult(value="from claude")}

    async def read_crop(self, ctx, image_b64, media_type, name):
        self.crops += 1
        return FieldResult(value="from claude")

    def same(self, name, a, b):
        return a == b


def test_claude_takes_over_when_gemini_quota_runs_out_and_the_flags_follow(tmp_path):
    from pipeline.readers import QuotaFallbackReader

    img = tmp_path / "p.png"
    Image.new("RGB", (40, 40), "white").save(img)
    gem = GeminiReader(GeminiClient(api_key="k", model="m", send=Sender((429, {}, DAILY_QUOTA)), max_retries=0, base_delay=0))
    claude = _Claude()
    reader = QuotaFallbackReader(gem, claude)
    assert reader.tighten_boxes is False and reader.box_pad == 0.10  # Gemini's flags while it is serving
    got = asyncio.run(reader.read_page(Context(settings=None, pipeline_cfg={}, senders_cfg={}, client=None), str(img)))
    assert got["full_name"].value == "from claude" and claude.pages == 1
    assert reader.tighten_boxes is True and reader.box_pad == 0.0  # and Claude's once it has taken over
    asyncio.run(reader.read_crop(None, "b64", "image/jpeg", "full_name"))
    assert claude.crops == 1  # later calls go straight to Claude, without asking Gemini again


def test_the_fallback_exists_only_when_there_is_a_claude_key():
    from pipeline.readers import QuotaFallbackReader

    assert isinstance(build_reader(settings(gemini_api_key="k", gemini_model="m", anthropic_api_key="c"),
                                   {"provider": "gemini"}), QuotaFallbackReader)
    assert isinstance(build_reader(settings(gemini_api_key="k", gemini_model="m"), {"provider": "gemini"}),
                      GeminiReader)
