"""Scans are deleted automatically once a batch was exported and its review is over.

Only the uploaded files and page images go (the encrypted blobs); the extracted data, the audit log and the export
records stay. A batch is purged `export_retention_minutes` after its LAST export, and only when nothing in it still
waits for a fix or an approval (otherwise the reviewer would lose the page they are reading).
"""
import asyncio
from datetime import datetime, timedelta
from typing import List

from sqlalchemy import update
from sqlmodel import Session, select

from app.config import get_settings
from app.db import get_engine
from app.logging_utils import get_logger, log_event
from app.models import Batch, ExportRecord, Form, SourceFile
from app.workflow import APPROVED

log = get_logger("retention")
SWEEP_SECONDS = 60


def _unfinished(s: Session, batch_id: int) -> bool:
    return s.exec(select(Form.id).where(Form.batch_id == batch_id, Form.status.in_(["pending", "processing"]))).first() \
        is not None or s.exec(select(Form.id).where(Form.batch_id == batch_id, Form.status == "done",
                                                    Form.workflow != None,  # noqa: E711
                                                    Form.workflow != APPROVED)).first() is not None


def purge_batch(s: Session, batch_id: int) -> None:
    s.exec(update(Form).where(Form.batch_id == batch_id).values(image_data=None, image_path=""))
    s.exec(update(SourceFile).where(SourceFile.batch_id == batch_id).values(content=None))


def purge_expired(now: datetime = None) -> List[int]:
    """Delete the scans of every batch whose last export is older than the retention. Returns the batch ids."""
    now = now or datetime.utcnow()
    cutoff = now - timedelta(minutes=get_settings().export_retention_minutes)
    purged: List[int] = []
    with Session(get_engine()) as s:
        for batch in s.exec(select(Batch).where(Batch.status == "done")).all():
            last = s.exec(select(ExportRecord.created_at).where(ExportRecord.batch_id == batch.id)
                          .order_by(ExportRecord.created_at.desc())).first()
            if last is None or last > cutoff or _unfinished(s, batch.id):
                continue
            has_blobs = s.exec(select(Form.id).where(Form.batch_id == batch.id, Form.image_data != None)  # noqa: E711
                               ).first() is not None or s.exec(
                select(SourceFile.id).where(SourceFile.batch_id == batch.id, SourceFile.content != None)  # noqa: E711
            ).first() is not None
            if not has_blobs:
                continue
            purge_batch(s, batch.id)
            purged.append(batch.id)
            log_event(log, "scans_purged", batch_id=batch.id)
        s.commit()
    return purged


async def sweep_forever() -> None:
    while True:
        try:
            purge_expired()
        except Exception:
            log.exception("retention sweep failed")
        await asyncio.sleep(SWEEP_SECONDS)
