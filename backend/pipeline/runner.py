"""Runs source files through the stages in pipeline.yaml and persists results."""
import asyncio
import importlib
import inspect
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from sqlmodel import Session, select

from app import audit, corrections, events, identity, patients
from app.config import Settings, get_settings
from app.db import get_engine
from app.logging_utils import get_logger, log_event
from app.fields import LEVEL_EMPTY, OPTIONAL_FIELDS
from app.models import Batch, Field, Form, SourceFile
from app.workflow import initial_workflow
from pipeline import control
from pipeline.base import SKIPPED_TYPES, Context, FormDoc
from pipeline.stages.document import read_document

log = get_logger("runner")


def load_stages(pipeline_cfg: Dict[str, Any]) -> List[Any]:
    stages = []
    for spec in pipeline_cfg["stages"]:
        module_name, cls_name = spec.split(":")
        cls = getattr(importlib.import_module(module_name), cls_name)
        stages.append(cls())
    return stages


def build_context(settings: Optional[Settings] = None, client: Any = None,
                  batch_dir: Optional[Path] = None) -> Context:
    s = settings or get_settings()
    pcfg = s.pipeline
    from pipeline.readers import build_reader

    reader = build_reader(s, pcfg.get("extract") or {})  # fails fast on a missing Gemini key / model
    if client is None:
        from pipeline.claude_client import ClaudeClient

        ex = pcfg.get("extract", {})
        client = ClaudeClient(
            api_key=s.anthropic_api_key,
            ssl_cert_file=s.ssl_cert_file,
            model=s.claude_model,
            concurrency=ex.get("concurrency", 5),
            max_retries=ex.get("max_retries", 4),
            base_delay=ex.get("base_delay_seconds", 1.0),
            max_tokens=ex.get("max_tokens", 2048),
            adaptive=bool(ex.get("adaptive", False)),
        )
    models = {k: v for k, v in (pcfg.get("models") or {}).items() if isinstance(k, str)}
    return Context(settings=s, pipeline_cfg=pcfg, senders_cfg=s.senders,
                   client=client, batch_dir=batch_dir, lessons=_load_lessons(pcfg, s.senders),
                   models=models, rules=_load_rules(), extras={"reader": reader})


def _load_rules() -> List[Any]:
    """Active validation rules written by the lab manager. Never a reason to fail a batch."""
    try:
        from app.models import ValidationRule

        with _session() as s:
            rules = s.exec(select(ValidationRule).where(ValidationRule.status == "active")).all()
            for r in rules:
                s.expunge(r)
            return list(rules)
    except Exception as e:
        log_event(log, "rules_unavailable", error=type(e).__name__)
        return []


def _load_lessons(pipeline_cfg: Dict[str, Any], senders_cfg: Dict[str, Any]) -> Any:
    """What human corrections taught so far. Never a reason to fail a batch: no lessons is a valid state."""
    from pipeline.learning import load_lessons

    try:
        with _session() as s:
            return load_lessons(s, pipeline_cfg.get("learning"), senders_cfg)
    except Exception as e:
        log_event(log, "lessons_unavailable", error=type(e).__name__)
        return None


async def run_stage(stage: Any, doc: FormDoc, ctx: Context) -> List[FormDoc]:
    if inspect.iscoroutinefunction(stage.run):
        out = await stage.run(doc, ctx)
    else:
        out = await asyncio.to_thread(stage.run, doc, ctx)
    return out if isinstance(out, list) else [out]


# ---------- persistence helpers (short sync sessions) ----------

def _session() -> Session:
    return Session(get_engine())


def _update(model, obj_id: int, **values) -> None:
    with _session() as s:
        obj = s.get(model, obj_id)
        if obj is None:
            return
        for k, v in values.items():
            setattr(obj, k, v)
        s.add(obj)
        s.commit()
        batch_id = obj.id if model is Batch else getattr(obj, "batch_id", None)
    events.bump(batch_id)


def _create_form(doc: FormDoc) -> int:
    image = Path(doc.image_path)
    with _session() as s:
        form = Form(batch_id=doc.batch_id, source_file_id=doc.source_file_id,
                    page_index=doc.page_index, image_path=doc.image_path, status="processing",
                    image_data=image.read_bytes() if image.is_file() else None,
                    region_index=doc.region_index, region_box=_dump(doc.region_box),
                    started_at=datetime.utcnow())
        s.add(form)
        s.commit()
        s.refresh(form)
        form_id = form.id
    events.bump(doc.batch_id)
    return form_id


def _refresh_image(doc: FormDoc) -> None:
    image = Path(doc.image_path)
    if image.is_file():
        with _session() as s:
            rev = (s.get(Form, doc.form_id).image_rev or 0) + 1
        _update(Form, doc.form_id, image_data=image.read_bytes(), image_rev=rev)


def _dump(v: Any) -> Optional[str]:
    return None if v is None else json.dumps(v, ensure_ascii=False)


def _form_reasons(s: Session, form_id: int, doc: FormDoc) -> List[str]:
    """Form-level doubts found while reading, plus the ones only visible once the fields are known."""
    from pipeline.duplicates import has_duplicate_commitment

    reasons = list(doc.form_reasons)
    if doc.fields and all(fr.value in (None, "", []) for fr in doc.fields.values()):
        reasons.append("empty_form")
    numbers = doc.fields.get("commitment_numbers")
    if doc.doc_type == "commitment" and numbers is not None and numbers.value:
        values = numbers.value if isinstance(numbers.value, list) else [numbers.value]
        if has_duplicate_commitment(s, form_id, values):
            reasons.append("possible_duplicate")
    return list(dict.fromkeys(reasons))


def save_skipped(form_id: int, doc: FormDoc) -> None:
    """A page that is not read (not a commitment, or blank): kept with its image, no fields, no workflow."""
    with _session() as s:
        corrections.detach_form(s, form_id)
        for old in s.exec(select(Field).where(Field.form_id == form_id)).all():
            s.delete(old)
        form = s.get(Form, form_id)
        form.status, form.error, form.error_code = "done", None, None
        form.doc_type, form.workflow = doc.doc_type, None
        form.reasons = json.dumps(doc.form_reasons, ensure_ascii=False)
        form.refining = False
        form.doc_meta = _dump(doc.doc_meta)
        if doc.image_path and Path(doc.image_path).is_file():
            form.image_data = Path(doc.image_path).read_bytes()
            form.image_rev = (form.image_rev or 0) + 1
        s.add(form)
        patients.link_patient(s, form)
        s.commit()
    events.bump(doc.batch_id)


def _workflow_levels(doc: FormDoc) -> List[str]:
    """Levels that decide the starting workflow: an optional field left empty never holds a form back."""
    return [fr.level for n, fr in doc.fields.items() if not (n in OPTIONAL_FIELDS and fr.level == LEVEL_EMPTY)]


def save_fields(form_id: int, doc: FormDoc, provisional: bool = False,
                pipeline_cfg: Optional[Dict[str, Any]] = None) -> None:
    """Store the fields read for a form (replacing earlier ones) and give it its starting workflow.

    provisional: the zoomed checks are still running (form.refining); `refine_fields` finishes the job.
    """
    with _session() as s:
        identity.reconcile(s, doc, form_id, pipeline_cfg)
        corrections.detach_form(s, form_id)  # re-read: the human edits go, what they taught stays
        for old in s.exec(select(Field).where(Field.form_id == form_id)).all():
            s.delete(old)
        for name, fr in doc.fields.items():
            s.add(Field(
                form_id=form_id, name=name, value=_dump(fr.value), raw_value=_dump(fr.raw_value),
                confidence=fr.confidence, level=fr.level, box=_dump(fr.box), box_verified=fr.box_verified,
                reasons=json.dumps(fr.reasons, ensure_ascii=False),
            ))
        form = s.get(Form, form_id)
        form.status, form.error, form.error_code = "done", None, None
        if doc.image_path and Path(doc.image_path).is_file():
            form.image_data = Path(doc.image_path).read_bytes()  # the page may have been turned upright
            form.image_rev = (form.image_rev or 0) + 1
        reasons = _form_reasons(s, form_id, doc)
        form.doc_type = doc.doc_type if doc.doc_type not in SKIPPED_TYPES else "commitment"
        form.reasons = json.dumps(reasons, ensure_ascii=False)
        form.region_index, form.region_box = doc.region_index, _dump(doc.region_box)
        form.premerge_fields = None
        form.refining = provisional
        before = form.workflow
        form.workflow = initial_workflow(_workflow_levels(doc), reasons)
        form.approver_comment = None
        if form.assigned_to is None:
            batch = s.get(Batch, form.batch_id)
            form.assigned_to = batch.uploaded_by if batch else None
        s.add(form)
        s.flush()
        patients.link_patient(s, form)
        audit.record(s, None, "status_change", "form", form_id,
                     before={"workflow": before}, after={"workflow": form.workflow})
        s.commit()
    events.bump(doc.batch_id)


def _touched(fld: Field) -> bool:
    """A person already worked on this field (corrected or approved it): background checks leave it alone."""
    return bool(fld.manually_corrected) or (fld.version or 0) != 0


def refine_fields(form_id: int, doc: FormDoc, provisional_workflow: Optional[str],
                  pipeline_cfg: Optional[Dict[str, Any]] = None) -> None:
    """Finish a provisionally saved form with the results of the background checks (localize, double check).

    Rows are updated in place, never replaced, and a field someone touched in the meantime is kept as is.
    The workflow is recomputed only while nobody has touched the form.
    """
    with _session() as s:
        form = s.get(Form, form_id)
        if form is None:
            return
        identity.reconcile(s, doc, form_id, pipeline_cfg)
        rows = {f.name: f for f in s.exec(select(Field).where(Field.form_id == form_id)).all()}
        any_touched = False
        for name, fr in doc.fields.items():
            fld = rows.get(name)
            if fld is None:
                continue
            if _touched(fld):
                any_touched = True
                continue
            fld.value, fld.raw_value = _dump(fr.value), _dump(fr.raw_value)
            fld.confidence, fld.level = fr.confidence, fr.level
            fld.box, fld.box_verified = _dump(fr.box), fr.box_verified
            fld.reasons = json.dumps(fr.reasons, ensure_ascii=False)
            s.add(fld)
        form.refining = False
        if form.image_path and Path(form.image_path).is_file():
            form.image_data = Path(form.image_path).read_bytes()
            form.image_rev = (form.image_rev or 0) + 1
        reasons = _form_reasons(s, form_id, doc)
        form.reasons = json.dumps(reasons, ensure_ascii=False)
        before = form.workflow
        if not any_touched and form.workflow == provisional_workflow:
            form.workflow = initial_workflow(_workflow_levels(doc), reasons)
        s.add(form)
        s.flush()
        patients.link_patient(s, form)
        if form.workflow != before:
            audit.record(s, None, "status_change", "form", form_id,
                         before={"workflow": before}, after={"workflow": form.workflow})
        s.commit()
    events.bump(doc.batch_id)


def _workflow_of(form_id: int) -> Optional[str]:
    with _session() as s:
        form = s.get(Form, form_id)
        return form.workflow if form else None


def _provisional(doc: FormDoc, ctx: Context) -> FormDoc:
    """A copy of the doc with the levels the confidence stage gives before any zoomed re-read."""
    from pipeline.stages.confidence import provisional

    copy = doc.model_copy(deep=True)
    provisional(copy, ctx)
    return copy


# ---------- execution ----------

ProgressFn = Optional[Callable[[int], None]]
_NOT_SAVED = object()  # run_one: no provisional save happened (yet)


class StageTimeout(RuntimeError):
    """One page took too long in one stage: it fails alone (and can be retried), the batch goes on."""
    code = "timeout"


async def run_docs(stages: List[Any], docs: List[FormDoc], ctx: Context,
                   on_progress: ProgressFn = None, start: int = 0,
                   persist: bool = True, results: Optional[List[FormDoc]] = None) -> None:
    """Run docs through stages[start:], fanning out on list results.

    Each form fails independently. A failure before a form exists (e.g. an
    unreadable file) is re-raised so the caller can mark the source file failed.
    on_progress(n): n > 0 announces a fan-out into n forms; n == 0 means one form finished.
    """
    n = len(stages)
    stage_timeout = ctx.pipeline_cfg.get("extract", {}).get("stage_timeout_seconds", 300)
    early = ctx.pipeline_cfg.get("early_save") or {}
    early_after = (early.get("after") or "validate").lower() if persist and early.get("enabled") else None
    names = [type(st).__name__.lower() for st in stages]
    if early_after not in names or names.index(early_after) == n - 1:
        early_after = None  # nothing left to finish in the background: save once, at the end

    async def run_one(doc: FormDoc, idx: int) -> None:
        provisional_workflow: Any = _NOT_SAVED
        try:
            for i in range(idx, n):
                await control.checkpoint(doc.batch_id)
                if doc.image_path and stage_timeout:  # a page stuck in one stage fails alone; the batch goes on
                    try:
                        outs = await asyncio.wait_for(run_stage(stages[i], doc, ctx), stage_timeout)
                    except asyncio.TimeoutError:
                        raise StageTimeout(f"{type(stages[i]).__name__} took over {stage_timeout}s") from None
                else:
                    outs = await run_stage(stages[i], doc, ctx)
                if persist:
                    for o in outs:
                        if o.image_path and o.form_id is None:
                            o.form_id = _create_form(o)
                        elif o.image_path and o.form_id is not None and names[i] == "classify":
                            _refresh_image(o)  # classify turned / straightened the page: show that one from now on
                if len(outs) != 1:
                    if on_progress:
                        on_progress(len(outs))
                    await asyncio.gather(*(run_one(o, i + 1) for o in outs))
                    return
                doc = outs[0]
                if doc.doc_type in SKIPPED_TYPES and doc.image_path:
                    break  # not a commitment (or blank): nothing to read on it
                if (names[i] == early_after and doc.form_id is not None and doc.fields
                        and provisional_workflow is _NOT_SAVED):
                    # Readable now: show it for review while the zoomed checks run on.
                    save_fields(doc.form_id, _provisional(doc, ctx), provisional=True, pipeline_cfg=ctx.pipeline_cfg)
                    provisional_workflow = _workflow_of(doc.form_id)
                    log_event(log, "form_ready_provisional", form_id=doc.form_id)
                    if on_progress:
                        on_progress(0)
            if persist and doc.form_id is not None:
                if doc.doc_type in SKIPPED_TYPES:
                    if doc.doc_type == "other_medical" and (ctx.pipeline_cfg.get("documents") or {}).get("read"):
                        await read_document(doc, ctx)
                    save_skipped(doc.form_id, doc)
                    log_event(log, "form_skipped", form_id=doc.form_id, doc_type=doc.doc_type)
                elif provisional_workflow is not _NOT_SAVED:
                    refine_fields(doc.form_id, doc, provisional_workflow, ctx.pipeline_cfg)
                    log_event(log, "form_done", form_id=doc.form_id)
                else:
                    save_fields(doc.form_id, doc, pipeline_cfg=ctx.pipeline_cfg)
                    log_event(log, "form_done", form_id=doc.form_id)
            if results is not None:
                results.append(doc)
            if on_progress and provisional_workflow is _NOT_SAVED:
                on_progress(0)
        except control.BatchCancelled:
            if persist and doc.form_id is not None and provisional_workflow is not _NOT_SAVED:
                # Already shown for review: a failed background check keeps the provisional read.
                _update(Form, doc.form_id, refining=False)
            elif persist and doc.form_id is not None:
                _update(Form, doc.form_id, status="failed", error="בוטל על ידי המשתמש", error_code="cancelled")
            raise
        except Exception as e:
            log_event(log, "form_failed", form_id=doc.form_id,
                      source_file_id=doc.source_file_id, error=type(e).__name__)
            if getattr(e, "code", None) == "api_unavailable" and persist:
                _api_unavailable(doc.batch_id)
            if persist and doc.form_id is not None:
                _update(Form, doc.form_id, status="failed",
                        error=f"{type(e).__name__}: {e}"[:500], error_code=getattr(e, "code", None))
                if on_progress:
                    on_progress(0)
            elif doc.image_path and results is not None:
                doc.form_type = "__failed__"
                results.append(doc)
            else:
                raise

    await asyncio.gather(*(run_one(d, start) for d in docs))


async def process_source_file(sf_id: int, batch_id: int, stages: List[Any], ctx: Context) -> None:
    with _session() as s:
        path = s.get(SourceFile, sf_id).path
    _update(SourceFile, sf_id, status="processing", progress=0.0)
    state = {"total": 1, "done": 0}

    def on_progress(fanout: int) -> None:
        if fanout:
            state["total"] += fanout - 1  # one doc became `fanout` (pages, or several forms on one page)
        else:
            state["done"] += 1
        _update(SourceFile, sf_id, progress=min(state["done"] / max(state["total"], 1), 1.0))

    doc = FormDoc(batch_id=batch_id, source_file_id=sf_id, file_path=path)
    try:
        await run_docs(stages, [doc], ctx, on_progress)
        _merge_pages(sf_id, ctx)
        _update(SourceFile, sf_id, status="done", progress=1.0,
                warnings=json.dumps(doc.file_warnings), pages_total=len(doc.pages) or None)
        log_event(log, "file_done", source_file_id=sf_id)
    except control.BatchCancelled:
        _update(SourceFile, sf_id, status="failed", error="בוטל על ידי המשתמש", error_code="cancelled")
        log_event(log, "file_cancelled", source_file_id=sf_id)
    except Exception as e:
        log_event(log, "file_failed", source_file_id=sf_id, error=type(e).__name__)
        _update(SourceFile, sf_id, status="failed", error=f"{type(e).__name__}: {e}"[:500],
                error_code=getattr(e, "code", None) or "processing_failed",
                warnings=json.dumps(doc.file_warnings))


def _merge_pages(sf_id: int, ctx: Context) -> None:
    """Fold continuation pages into the form they continue. Never fails the file: unmerged pages stay forms."""
    if not ctx.pipeline_cfg.get("merge_pages", {}).get("enabled", True):
        return
    from pipeline.merge import auto_merge_file

    try:
        with _session() as s:
            auto_merge_file(s, sf_id)
    except Exception as e:
        log_event(log, "merge_failed", source_file_id=sf_id, error=type(e).__name__)


def _api_unavailable(batch_id: int) -> None:
    """The API refuses every request: pause the batch once and tell the user, instead of failing every form."""
    if not control.is_paused(batch_id):
        control.pause(batch_id)
        _update(Batch, batch_id, notice="api_unavailable")
        log_event(log, "batch_paused_api_unavailable", batch_id=batch_id)


async def process_batch(batch_id: int, ctx: Optional[Context] = None) -> None:
    settings = get_settings()
    ctx = ctx or build_context(settings)
    if ctx.batch_dir is None:
        ctx.batch_dir = settings.batches_dir / str(batch_id)
    stages = load_stages(ctx.pipeline_cfg)
    _update(Batch, batch_id, started_at=datetime.utcnow())
    with _session() as s:
        sf_ids = [sf.id for sf in s.exec(select(SourceFile).where(SourceFile.batch_id == batch_id)).all()
                  if sf.status != "failed"]  # rejected on upload (empty, too large...): nothing to read
    log_event(log, "batch_start", batch_id=batch_id, files=len(sf_ids))
    await asyncio.gather(*(process_source_file(i, batch_id, stages, ctx) for i in sf_ids))
    finish_batch_if_complete(batch_id, ctx.batch_dir, force=True)


def finish_batch_if_complete(batch_id: int, batch_dir: Optional[Path] = None, force: bool = False) -> bool:
    """Mark the batch done once every expected file has arrived and finished.

    force: the caller processed every file of the batch itself (the classic one-request upload).
    """
    with _session() as s:
        batch = s.get(Batch, batch_id)
        if batch is None or batch.status != "processing":
            return False
        files = s.exec(select(SourceFile).where(SourceFile.batch_id == batch_id)).all()
        if not force:
            if batch.expected_files is None or len(files) < batch.expected_files:
                return False
            if any(f.status in ("pending", "processing") for f in files):
                return False
        batch.status, batch.finished_at = "done", datetime.utcnow()
        s.add(batch)
        s.commit()
    control.clear(batch_id)
    _drop_working_files(batch_dir or get_settings().batches_dir / str(batch_id))
    log_event(log, "batch_done", batch_id=batch_id)
    return True


async def process_uploaded_file(sf_id: int, batch_id: int, ctx: Optional[Context] = None) -> None:
    """Per-file upload: read this file now, without waiting for the rest of the batch to arrive."""
    settings = get_settings()
    try:
        ctx = ctx or build_context(settings)
        if ctx.batch_dir is None:
            ctx.batch_dir = settings.batches_dir / str(batch_id)
        with _session() as s:
            batch = s.get(Batch, batch_id)
            if batch is not None and batch.started_at is None:
                batch.started_at = datetime.utcnow()
                s.add(batch)
                s.commit()
        stages = load_stages(ctx.pipeline_cfg)
    except Exception as e:
        # Setup failed before the file started: without this it stays "pending" (queued) forever, with no trace.
        log.exception("file setup failed (source_file_id=%s)", sf_id)
        _update(SourceFile, sf_id, status="failed", error=f"{type(e).__name__}: {e}"[:500],
                error_code="processing_failed")
        finish_batch_if_complete(batch_id)
        return
    await process_source_file(sf_id, batch_id, stages, ctx)
    finish_batch_if_complete(batch_id, ctx.batch_dir)


def _drop_working_files(batch_dir: Optional[Path]) -> None:
    """Everything is kept in the DB; the on-disk copies are scratch space for the pipeline only."""
    if batch_dir:
        shutil.rmtree(batch_dir, ignore_errors=True)


def _restore_image(form_id: int) -> None:
    """Write the page image from the DB back to its working path so the stages can read it."""
    with _session() as s:
        form = s.get(Form, form_id)
        if form and form.image_data and form.image_path and not Path(form.image_path).is_file():
            Path(form.image_path).parent.mkdir(parents=True, exist_ok=True)
            Path(form.image_path).write_bytes(form.image_data)


async def retry_form(form_id: int, ctx: Optional[Context] = None, forced_type: Optional[str] = None) -> None:
    """Read one form again from its stored page image.

    forced_type: the user said what the page is ("it is a commitment"): classification is skipped.
    """
    settings = get_settings()
    with _session() as s:
        form = s.get(Form, form_id)
        doc = FormDoc(batch_id=form.batch_id, source_file_id=form.source_file_id, form_id=form.id,
                      page_index=form.page_index, image_path=form.image_path, forced_type=forced_type,
                      region_index=form.region_index,
                      region_box=json.loads(form.region_box) if form.region_box else None)
        batch_id = form.batch_id
        scan_gone = not form.image_data and not (form.image_path and Path(form.image_path).is_file())
        has_pages = s.exec(select(Form.id).where(Form.parent_form_id == form_id)).first() is not None
    if scan_gone:  # deleted after the export (app.retention): nothing left to read again
        _update(Form, form_id, status="failed", error="scan deleted after export", error_code="scan_deleted")
        return
    ctx = ctx or build_context(settings)
    if ctx.batch_dir is None:
        ctx.batch_dir = settings.batches_dir / str(batch_id)
    stages = load_stages(ctx.pipeline_cfg)
    names = [type(st).__name__.lower() for st in stages]
    start = names.index(ctx.pipeline_cfg.get("retry_from", "classify"))
    _restore_image(form_id)
    _update(Form, form_id, status="processing", error=None, error_code=None, workflow=None,
            started_at=datetime.utcnow())  # re-entered when it finishes
    log_event(log, "form_retry", form_id=form_id)
    try:
        await run_docs(stages, [doc], ctx, start=start)
        if has_pages:  # a merged form read again: fold its other pages in again
            from pipeline.merge import remerge_children

            with _session() as s:
                remerge_children(s, form_id)
    finally:
        Path(doc.image_path).unlink(missing_ok=True)
