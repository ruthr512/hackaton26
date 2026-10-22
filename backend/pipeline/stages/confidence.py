"""Stage 8 — confidence: what the system is sure of, from evidence rather than from the model's own word.

A model's self-reported confidence is poorly calibrated (it is "1.0" for most values, right or wrong), and some
providers give none at all. So a field's final confidence is built from independent signals:
  - the model's own score, capped when it flagged the value as hard to read;
  - an independent second read (a zoomed crop, optionally by another model): agreement lifts the confidence,
    disagreement (or a failed second read) caps it;
  - validation: a value that breaks a check (ID check digit, impossible date) was probably misread;
  - handwriting is never accepted after a single read.

The final confidence alone decides what happens to a field (pipeline.yaml `confidence`):
  - below `empty_below` (50%):  the value is dropped and the field is left empty, marked "not identified";
  - below `review_below` (80%): a person checks it;
  - from `review_below` up:     approved automatically.
Business holds (sender not in the list, a lab rule, a learned risk) still send a field to a person: they are not a
statement about how well it was read, so they do not change the confidence.
"""
import asyncio
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from app.fields import LEVEL_EMPTY, LEVEL_OK, LEVEL_REVIEW
from app.logging_utils import get_logger, log_event
from pipeline.base import Context, FieldResult, FormDoc
from pipeline.crops import MEDIA_TYPE, crop_b64, halves_b64, pad_box
from pipeline.learning import lessons_of
from pipeline.normalizers import normalize_field
from pipeline.readers import reader_of
from pipeline.stages.extract import encode_page
from pipeline.stages.validate import Validate

log = get_logger("confidence")

# Empty fields worth a zoomed re-read: the ones most often handwritten.
RECOVERABLE = ("full_name", "id_number")

# A broken check of these kinds means the value was probably misread; other validation reasons are business holds.
MISREAD_CODES = {"invalid_id_checksum", "invalid_date", "future_date"}
# Soft reasons that mean "the value was changed by a guess" (a sender spelling mapped onto the list).
GUESSED_CODES = {"sender_fuzzy_match"}

NOT_IDENTIFIED = "not_identified"

AGREE, DISAGREE, FAILED, RECOVERED = "agree", "disagree", "failed", "recovered"


@dataclass(frozen=True)
class Policy:
    empty_below: float = 0.50  # under this the value is dropped ("not identified")
    review_below: float = 0.80  # under this a person checks it; from here on it is approved automatically
    agree_bonus: float = 0.15  # two independent reads agree
    disagree_cap: float = 0.60  # they do not, or the second read failed
    misread_cap: float = 0.60  # a check digit / date check failed
    doubt_cap: float = 0.70  # the model said it is hard to read, or a spelling was matched by guess
    unverified_cap: float = 0.79  # handwriting (or anything about to be verified) is not accepted on one read
    neutral: float = 0.70  # the provider gives no confidence of its own: start from "probably right"

    @classmethod
    def from_cfg(cls, pipeline_cfg: Dict[str, Any]) -> "Policy":
        cfg = pipeline_cfg.get("confidence") or {}
        return cls(**{k: float(cfg[k]) for k in cls.__dataclass_fields__ if k in cfg})


@dataclass
class Check:
    """The result of the independent second read of one field."""
    outcome: str  # agree | disagree | failed | recovered
    confidence: float = 0.0  # the second read's own score
    reports: bool = True  # whether that score means anything (some providers give none)


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def settle(fr: FieldResult, policy: Policy, reports: bool = True, check: Optional[Check] = None,
           verification_pending: bool = False, final: bool = True) -> None:
    """Set the confidence and the level of one field from all the evidence. Mutates `fr`.

    verification_pending: a second read is still to come, so a single read is not enough yet.
    final=False: never drops a value (the page is shown for review while the checks run).
    """
    if fr.value is None:
        # empty, unless a rule says it must not be (e.g. a required referral number)
        fr.level = LEVEL_REVIEW if any(r["kind"] == "validation" for r in fr.reasons) else LEVEL_EMPTY
        return

    conf = fr.confidence if reports else policy.neutral
    if not fr.legible:
        conf = min(conf, policy.doubt_cap)
        fr.add_reason("soft", "illegible")

    if check is not None and check.outcome in (AGREE, RECOVERED):
        if check.outcome == AGREE:
            second = check.confidence if check.reports else conf
            conf = (conf + second) / 2 + policy.agree_bonus
        else:
            conf = min(check.confidence if check.reports else policy.neutral, policy.unverified_cap)
    elif check is not None:  # disagree / failed
        conf = min(conf, policy.disagree_cap)
    elif fr.handwritten or verification_pending:
        conf = min(conf, policy.unverified_cap)
        if fr.handwritten and not verification_pending:
            fr.add_reason("soft", "handwritten")

    if any(r["code"] in MISREAD_CODES for r in fr.reasons):
        conf = min(conf, policy.misread_cap)
    if any(r["code"] in GUESSED_CODES for r in fr.reasons):
        conf = min(conf, policy.doubt_cap)
    fr.confidence = _clamp(conf)

    if final and fr.confidence < policy.empty_below:
        fr.add_reason("info", NOT_IDENTIFIED)
        fr.value, fr.level = None, LEVEL_EMPTY
        fr.reasons = [r for r in fr.reasons if r["kind"] == "info"]  # nothing left to validate or doubt
        return
    if fr.confidence < policy.review_below:
        fr.add_reason("soft", "low_confidence")
        fr.level = LEVEL_REVIEW
    else:
        fr.level = LEVEL_REVIEW if any(r["kind"] in ("validation", "double_check", "soft") for r in fr.reasons) \
            else LEVEL_OK


def settle_all(fields: Dict[str, FieldResult], policy: Policy, reports: bool, checks: Optional[Dict[str, Check]] = None,
               verification_pending: bool = False, final: bool = True) -> None:
    for name, fr in fields.items():
        settle(fr, policy, reports, (checks or {}).get(name), verification_pending, final)


async def _reread(ctx: Context, form: FormDoc, name: str) -> Optional[FieldResult]:
    """Second read of one field: from its crop, else page halves (empty field) or the full page."""
    reader = reader_of(ctx)
    fr = form.fields[name]
    box = fr.box or fr.hint_box
    if box and reader.box_pad:
        box = pad_box(box, reader.box_pad)
    crop = crop_b64(form.image_path, box, margin=reader.crop_margin)
    if crop:
        return await reader.read_crop(ctx, crop, MEDIA_TYPE, name)
    if fr.value is None:
        # No box to zoom into: read both halves (in parallel); keep a value only if they don't conflict.
        reads = await asyncio.gather(*(reader.read_crop(ctx, half, MEDIA_TYPE, name)
                                       for half in halves_b64(form.image_path)))
        values = [got for got in reads if got.value is not None]
        if not values or any(not reader.same(name, v.value, values[0].value) for v in values[1:]):
            return None
        return values[0]
    return await reader.read_crop(ctx, encode_page(form.image_path), "image/jpeg", name)


def apply_lessons(form: FormDoc, ctx: Context) -> None:
    """Show where a value came from a lesson, and never let a field reviewers keep catching pass unseen."""
    risky = lessons_of(ctx).risky
    for n, fr in form.fields.items():
        if fr.learned:
            fr.add_reason("info", "learned_correction")
        if fr.level == LEVEL_OK and n in risky:
            fr.add_reason("soft", "often_corrected")
            fr.level = LEVEL_REVIEW
            log_event(log, "field_held_for_review", form_id=form.form_id, field=n, rate=risky[n])


def provisional(form: FormDoc, ctx: Context) -> None:
    """Levels before the second reads ran: nothing is accepted yet if a second read is coming, nothing is dropped."""
    reader = reader_of(ctx)
    pending = bool(ctx.pipeline_cfg.get("double_check", {}).get("enabled", False))
    settle_all(form.fields, Policy.from_cfg(ctx.pipeline_cfg), reader.reports_confidence,
               verification_pending=pending, final=False)
    apply_lessons(form, ctx)


class Confidence:
    async def run(self, form: FormDoc, ctx: Context) -> FormDoc:
        form = await self._assess(form, ctx)
        apply_lessons(form, ctx)
        return form

    def _candidates(self, form: FormDoc, ctx: Context, policy: Policy, reports: bool) -> List[str]:
        cfg = ctx.pipeline_cfg.get("double_check") or {}
        if str(cfg.get("scope", "all")).lower() == "all":
            # Every value is read twice, independently; fields with a hard reason are re-read too (a disagreement
            # is worth knowing) but agreement never clears them.
            return [n for n, fr in form.fields.items() if fr.value is not None or n in RECOVERABLE]
        # Only doubtful fields: those a single read would send to a person for soft reasons only.
        trial = form.model_copy(deep=True)
        settle_all(trial.fields, policy, reports, final=False)
        return [
            n for n, fr in trial.fields.items()
            if (fr.level == LEVEL_REVIEW and all(r["kind"] in ("soft", "info") for r in fr.reasons))
            or (fr.value is None and n in RECOVERABLE)
        ]

    async def _assess(self, form: FormDoc, ctx: Context) -> FormDoc:
        policy = Policy.from_cfg(ctx.pipeline_cfg)
        reader = reader_of(ctx)
        enabled = bool(ctx.pipeline_cfg.get("double_check", {}).get("enabled", False))
        candidates = self._candidates(form, ctx, policy, reader.reports_confidence) if enabled else []

        checks: Dict[str, Check] = {}
        recovered = False
        if candidates:
            results = await asyncio.gather(*(_reread(ctx, form, n) for n in candidates), return_exceptions=True)
            for n, second in zip(candidates, results):
                fr = form.fields[n]
                if isinstance(second, Exception):
                    log_event(log, "double_check_failed", form_id=form.form_id, field=n, error=type(second).__name__)
                    if fr.value is not None:
                        fr.add_reason("double_check", "double_check_failed")
                        checks[n] = Check(FAILED)
                    continue
                second_value = None
                if second is not None:
                    second_value, _ = normalize_field(n, second.value, ctx.senders_cfg)
                reports = reader.check_reports_confidence

                if fr.value is None:
                    if second_value is None:
                        continue
                    fr.value, fr.raw_value = second_value, second.value
                    fr.legible, fr.handwritten = second.legible, second.handwritten
                    # second.box is relative to the crop, not the page: keep the page box from the first read.
                    fr.add_reason("soft", "recovered_on_zoom")
                    checks[n] = Check(RECOVERED, second.confidence, reports)
                    recovered = True
                    log_event(log, "field_recovered_on_zoom", form_id=form.form_id, field=n)
                elif second_value is not None and reader.same(n, fr.value, second_value):
                    fr.add_reason("info", "double_check_confirmed")
                    checks[n] = Check(AGREE, second.confidence, reports)
                    if not second.legible:
                        checks[n] = Check(DISAGREE)  # the second reader could not make it out: not a confirmation
                        fr.reasons = [r for r in fr.reasons if r["code"] != "double_check_confirmed"]
                else:
                    fr.add_reason("double_check", "double_check_disagree")
                    checks[n] = Check(DISAGREE)

        if recovered:
            # A recovered ID must still pass the check digit; a failed check caps its confidence below.
            Validate().run(form, ctx)
        settle_all(form.fields, policy, reader.reports_confidence, checks)
        blanked = [n for n, fr in form.fields.items() if any(r["code"] == NOT_IDENTIFIED for r in fr.reasons)]
        if blanked:
            Validate().run(form, ctx)  # a lab rule may now need a value that is missing
            for fr in form.fields.values():
                held = any(r["kind"] == "validation" for r in fr.reasons)
                if fr.value is None:
                    fr.level = LEVEL_REVIEW if held else LEVEL_EMPTY
                elif held and fr.level == LEVEL_OK:
                    fr.level = LEVEL_REVIEW
            log_event(log, "fields_not_identified", form_id=form.form_id, fields=blanked)
        return form
