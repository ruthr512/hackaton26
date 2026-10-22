from pipeline.normalizers import normalize_field
from validators.senders import is_canonical, match_sender


def test_exact_name(senders_cfg):
    assert match_sender("כללית", senders_cfg) == ("כללית", 100.0, True)


def test_alias(senders_cfg):
    name, _, exact = match_sender("תל השומר", senders_cfg)
    assert (name, exact) == ("שיבא", True)
    assert match_sender("Maccabi", senders_cfg)[0] == "מכבי"


def test_fuzzy_match_flags_soft_reason(senders_cfg):
    value, reasons = normalize_field("sender", "שירותי בריאות כלליתת", senders_cfg)
    assert value == "כללית"
    assert {"kind": "soft", "code": "sender_fuzzy_match"} in reasons


def test_no_match_keeps_raw_value(senders_cfg):
    name, _, _ = match_sender("מרפאת שיניים פרטית", senders_cfg)
    assert name is None
    value, _ = normalize_field("sender", "מרפאת שיניים פרטית", senders_cfg)
    assert value == "מרפאת שיניים פרטית"
    assert not is_canonical(value, senders_cfg)


# ---------- departments belong to their hospital; look-alikes do not match ----------

import pytest
import yaml

from app.config import REPO_ROOT
from validators.senders import add_sender, resolve_sender, strip_department

LANIADO = "לניאדו - מרכז רפואי צאנז"


@pytest.fixture
def full_cfg():
    with open(REPO_ROOT / "config" / "senders.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


@pytest.mark.parametrize("written", [
    "מחלקת פנימית ב' לניאדו", "מחלקה פנימית א׳ - לניאדו", "בית חולים לניאדו", "לניאדו", "מחלקת ילדים, בית החולים לניאדו",
])
def test_a_department_resolves_to_its_hospital(full_cfg, written):
    value, reasons = normalize_field("sender", written, full_cfg)
    assert value == LANIADO
    assert not any(r["kind"] == "soft" for r in reasons)  # nothing to check by hand: the hospital is in the list


def test_a_department_of_an_unknown_hospital_becomes_that_hospital(full_cfg):
    value, _ = normalize_field("sender", "מחלקת פנימית ב' ברוםנברג", full_cfg)
    assert value == "ברוםנברג" and not is_canonical(value, full_cfg)


def test_a_clinic_or_a_department_without_a_hospital_is_kept_as_written(full_cfg):
    assert strip_department("מרפאת שיניים פרטית") == "מרפאת שיניים פרטית"
    assert strip_department("מחלקת ילדים") == "מחלקת ילדים"


def test_a_lookalike_hospital_is_not_matched(full_cfg):
    assert resolve_sender("בית החולים סנט מרי", full_cfg)[0] is None  # not סנט ג'וזף


def test_an_ambiguous_name_matches_nothing(full_cfg):
    assert resolve_sender("בית חולים אסותא", full_cfg)[0] is None  # six Assuta hospitals
    assert resolve_sender("הדסה עין כרם", full_cfg)[0] == "מרכז רפואי הדסה - בית החולים עין כרם"


def test_a_health_fund_with_its_title_is_the_fund(full_cfg):
    assert normalize_field("sender", "קופת חולים מכבי", full_cfg)[0] == "מכבי"


def test_approving_an_unknown_hospital_adds_it_even_when_it_resembles_a_listed_one(full_cfg):
    assert add_sender(full_cfg, "בית החולים סנט מרי")
    assert is_canonical("בית החולים סנט מרי", full_cfg) and is_canonical("בית החולים סנט ג'וזף", full_cfg)


def test_an_approved_spelling_of_a_listed_sender_becomes_its_alias_not_a_second_sender(full_cfg):
    count = len(full_cfg["senders"])
    assert add_sender(full_cfg, "בית חולים לניאדו")
    assert len(full_cfg["senders"]) == count
    assert resolve_sender("בית חולים לניאדו", full_cfg) == (LANIADO, 100.0, "exact")
    assert not add_sender(full_cfg, "בית חולים לניאדו")  # known now
