import asyncio
import hashlib
import re
import shutil
from pathlib import Path
from typing import List, Optional, Set

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from app.api.serialize import batch_detail
from app.auth import (ROLE_APPROVER, ROLE_INTAKE, ROLE_MANAGER, has_role, check_batch_owner, check_batch_view, get_current_user,
                      require_roles)
from app.config import get_settings
from app.db import get_engine, get_session
from app.logging_utils import get_logger, log_event
from app.models import AuditLog, Batch, ExportRecord, ExportSetting, Field, Form, SourceFile, User
from pipeline import control
from pipeline.base import FileProblem
from pipeline.runner import finish_batch_if_complete, process_batch, process_uploaded_file, retry_form
from pipeline.stages.ingest import sniff_bytes

router = APIRouter(prefix="/api/batches", tags=["batches"])
log = get_logger("api")

ALLOWED_EXT = {".pdf", ".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff"}
_tasks: Set[asyncio.Task] = set()  # keep references so background tasks are not GC'd


def start_background(coro) -> None:
    task = asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    task.add_done_callback(_log_task_failure)


def _log_task_failure(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.error("background task failed", exc_info=task.exception())


def _safe_name(name: str) -> str:
    name = name.replace("\\", "/").split("/")[-1]
    return re.sub(r"[^\w.\-א-ת]", "_", name)[:120] or "file"


def _get_batch(s: Session, batch_id: int) -> Batch:
    batch = s.get(Batch, batch_id)
    if batch is None:
        raise HTTPException(404, "batch not found")
    return batch


class OpenBody(BaseModel):
    expected_files: int


def _ext_ok(name: Optional[str]) -> bool:
    return "." + (name or "").rsplit(".", 1)[-1].lower() in ALLOWED_EXT


def _accept_file(s: Session, batch: Batch, f: UploadFile, dest: Path) -> SourceFile:
    """Store one upload and check it before any reading: size, real content type, earlier copies.

    A bad file is kept as a failed SourceFile with a code (so the user sees why); it never fails the batch.
    """
    with open(dest, "wb") as out:
        shutil.copyfileobj(f.file, out)
    data = dest.read_bytes()
    sf = SourceFile(batch_id=batch.id, filename=f.filename or dest.name, path=str(dest), content=data,
                    sha256=hashlib.sha256(data).hexdigest())
    max_bytes = get_settings().max_file_mb * 1024 * 1024
    if not data:
        sf.status, sf.error, sf.error_code = "failed", "empty file", "empty_file"
    elif len(data) > max_bytes:
        sf.status, sf.error, sf.error_code, sf.content = "failed", "file too large", "file_too_large", None
    else:
        try:
            sniff_bytes(data[:16])
        except FileProblem as e:
            sf.status, sf.error, sf.error_code = "failed", str(e), e.code
    earlier = s.exec(select(SourceFile.batch_id).where(SourceFile.sha256 == sf.sha256,
                                                       SourceFile.batch_id != batch.id)).first()
    if data and earlier is not None:
        sf.duplicate_of_batch = earlier  # only a warning: the user decides
    s.add(sf)
    return sf


@router.post("/open")
def open_batch(body: OpenBody, s: Session = Depends(get_session),
               user: User = Depends(require_roles(ROLE_INTAKE, ROLE_MANAGER))):
    """Per-file upload, step 1: a batch that waits for `expected_files` files, each read as soon as it arrives."""
    if body.expected_files < 1:
        raise HTTPException(400, "no files")
    batch = Batch(uploaded_by=user.id, expected_files=body.expected_files)
    s.add(batch)
    s.commit()
    s.refresh(batch)
    log_event(log, "batch_opened", batch_id=batch.id, files=body.expected_files)
    return batch_detail(s, batch)


@router.post("/{batch_id}/files")
async def add_file(batch_id: int, file: UploadFile = File(...), s: Session = Depends(get_session),
                   user: User = Depends(require_roles(ROLE_INTAKE, ROLE_MANAGER))):
    """Per-file upload, step 2: one file (a failed or slow upload is retried alone, never the whole batch)."""
    batch = _get_batch(s, batch_id)
    check_batch_owner(user, batch)
    if batch.status != "processing" or batch.expected_files is None:
        raise HTTPException(409, "batch is not open for uploads")
    if not _ext_ok(file.filename):
        raise HTTPException(400, {"code": "unsupported_type", "detail": f"unsupported file type: {file.filename}"})
    n = len(s.exec(select(SourceFile.id).where(SourceFile.batch_id == batch_id)).all())
    if n >= batch.expected_files:
        raise HTTPException(409, "batch already has all its files")
    upload_dir = get_settings().batches_dir / str(batch_id) / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    sf = _accept_file(s, batch, file, upload_dir / f"{n + 1}_{_safe_name(file.filename or 'file')}")
    s.commit()
    s.refresh(sf)
    log_event(log, "file_uploaded", batch_id=batch_id, source_file_id=sf.id, status=sf.status)
    if sf.status == "pending":
        start_background(process_uploaded_file(sf.id, batch_id))
    else:
        finish_batch_if_complete(batch_id)
    return {"id": sf.id, "status": sf.status, "error_code": sf.error_code,
            "duplicate_of_batch": sf.duplicate_of_batch}


@router.post("/{batch_id}/close")
def close_batch(batch_id: int, s: Session = Depends(get_session), user: User = Depends(get_current_user)):
    """No more files will come (uploads were cancelled or gave up): finish with what arrived."""
    batch = _get_batch(s, batch_id)
    check_batch_owner(user, batch)
    if batch.status == "processing" and batch.expected_files is not None:
        n = len(s.exec(select(SourceFile.id).where(SourceFile.batch_id == batch_id)).all())
        batch.expected_files = n
        s.add(batch)
        s.commit()
        if n == 0:
            batch.status = "done"
            s.add(batch)
            s.commit()
        else:
            finish_batch_if_complete(batch_id)
    log_event(log, "batch_closed", batch_id=batch_id)
    s.refresh(batch)
    return batch_detail(s, batch)


@router.post("/{batch_id}/retry-failed")
async def retry_failed(batch_id: int, s: Session = Depends(get_session), user: User = Depends(get_current_user)):
    """Read every failed form of the batch again (after a restart, a timeout or the API coming back)."""
    batch = _get_batch(s, batch_id)
    check_batch_owner(user, batch)
    if batch.notice:
        batch.notice = None
        s.add(batch)
    failed = s.exec(select(Form).where(Form.batch_id == batch_id, Form.status == "failed")).all()
    for form in failed:
        form.status, form.error, form.error_code = "processing", None, None
        s.add(form)
    s.commit()
    for form in failed:
        start_background(retry_form(form.id))
    log_event(log, "batch_retry_failed", batch_id=batch_id, forms=len(failed))
    return {"ok": True, "forms": [f.id for f in failed]}


@router.post("")
async def create_batch(files: List[UploadFile] = File(...), s: Session = Depends(get_session),
                       user: User = Depends(require_roles(ROLE_INTAKE, ROLE_MANAGER))):
    if not files:
        raise HTTPException(400, "no files")
    for f in files:
        if not _ext_ok(f.filename):
            raise HTTPException(400, f"unsupported file type: {f.filename}")

    batch = Batch(uploaded_by=user.id)
    s.add(batch)
    s.commit()
    s.refresh(batch)
    upload_dir = get_settings().batches_dir / str(batch.id) / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    for i, f in enumerate(files):
        _accept_file(s, batch, f, upload_dir / f"{i + 1}_{_safe_name(f.filename or 'file')}")
    s.commit()
    log_event(log, "batch_created", batch_id=batch.id, files=len(files))
    start_background(process_batch(batch.id))
    return batch_detail(s, batch)


@router.get("")
def list_batches(s: Session = Depends(get_session), user: User = Depends(get_current_user)):
    query = select(Batch).order_by(Batch.id.desc())
    if not has_role(user, ROLE_APPROVER, ROLE_MANAGER):  # a clerk sees only own / assigned batches
        mine = select(Form.batch_id).where(Form.assigned_to == user.id)
        query = query.where((Batch.uploaded_by == user.id) | Batch.id.in_(mine))
    batches = s.exec(query).all()
    out = []
    for b in batches:
        n_files = len(s.exec(select(SourceFile.id).where(SourceFile.batch_id == b.id)).all())
        n_forms = len(s.exec(select(Form.id).where(Form.batch_id == b.id)).all())
        out.append({"id": b.id, "created_at": b.created_at.isoformat(), "status": b.status,
                    "files": n_files, "forms": n_forms})
    return out


@router.get("/{batch_id}")
def get_batch(batch_id: int, s: Session = Depends(get_session), user: User = Depends(get_current_user)):
    batch = _get_batch(s, batch_id)
    check_batch_view(s, user, batch)
    return batch_detail(s, batch)


SSE_HEARTBEAT_SECONDS = 15.0


@router.get("/{batch_id}/events")
async def batch_events(batch_id: int, user: User = Depends(get_current_user)):
    """Server-sent events: `changed` whenever something in the batch changes (the client then re-fetches).

    EventSource cannot send headers, so the token comes as ?token= (accepted by get_current_user).
    Holds no DB session while streaming.
    """
    from app import events

    with Session(get_engine()) as s:
        check_batch_view(s, user, _get_batch(s, batch_id))

    async def stream():
        seen = events.version(batch_id)
        yield f"event: changed\ndata: {seen}\n\n"
        while True:
            now = await events.wait_change(batch_id, seen, SSE_HEARTBEAT_SECONDS)
            if now == seen:
                yield ": heartbeat\n\n"
            else:
                seen = now
                yield f"event: changed\ndata: {now}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _running_batch(s: Session, batch_id: int, user: User) -> Batch:
    batch = _get_batch(s, batch_id)
    check_batch_owner(user, batch)
    if batch.status != "processing":
        raise HTTPException(409, "batch is not processing")
    return batch


@router.post("/{batch_id}/pause")
async def pause_batch(batch_id: int, s: Session = Depends(get_session),
                       user: User = Depends(get_current_user)):
    _running_batch(s, batch_id, user)
    control.pause(batch_id)
    log_event(log, "batch_paused", batch_id=batch_id)
    return {"ok": True, "paused": True}


@router.post("/{batch_id}/resume")
async def resume_batch(batch_id: int, s: Session = Depends(get_session),
                       user: User = Depends(get_current_user)):
    batch = _running_batch(s, batch_id, user)
    if batch.notice:  # the user fixed what stopped the batch (e.g. the API key): clear the message
        batch.notice = None
        s.add(batch)
        s.commit()
    control.resume(batch_id)
    log_event(log, "batch_resumed", batch_id=batch_id)
    return {"ok": True, "paused": False}


@router.post("/{batch_id}/cancel")
async def cancel_batch(batch_id: int, s: Session = Depends(get_session),
                       user: User = Depends(get_current_user)):
    _running_batch(s, batch_id, user)
    control.cancel(batch_id)
    log_event(log, "batch_cancelled", batch_id=batch_id)
    return {"ok": True}


@router.delete("/{batch_id}")
def delete_batch(batch_id: int, s: Session = Depends(get_session), user: User = Depends(get_current_user)):
    batch = _get_batch(s, batch_id)
    check_batch_owner(user, batch)
    if batch.status == "processing":
        raise HTTPException(409, "batch is still processing")
    form_ids = [f.id for f in s.exec(select(Form).where(Form.batch_id == batch_id)).all()]
    if form_ids:
        for fld in s.exec(select(Field).where(Field.form_id.in_(form_ids))).all():
            s.delete(fld)
        for row in s.exec(select(AuditLog).where(AuditLog.form_id.in_(form_ids))).all():
            s.delete(row)
    for model in (Form, SourceFile, ExportRecord):
        for row in s.exec(select(model).where(model.batch_id == batch_id)).all():
            s.delete(row)
    setting = s.get(ExportSetting, batch_id)
    if setting is not None:
        s.delete(setting)
    s.delete(batch)
    s.commit()
    shutil.rmtree(get_settings().batches_dir / str(batch_id), ignore_errors=True)
    log_event(log, "batch_deleted", batch_id=batch_id)
    return {"ok": True}
