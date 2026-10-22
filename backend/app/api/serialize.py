"""DB rows -> JSON-friendly dicts."""
import json
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import defer
from sqlmodel import Session, select

from app.fields import FIELD_NAMES, OPTIONAL_FIELDS
from app.models import Batch, Field, Form, SourceFile, ValidationRule
from app.workflow import APPROVED
from pipeline import control


def load_value(v: Optional[str]) -> Any:
    return None if v is None else json.loads(v)


def field_dict(f: Field) -> Dict[str, Any]:
    return {
        "id": f.id,
        "name": f.name,
        "value": load_value(f.value),
        "level": f.level,
        "confidence": f.confidence,
        "reasons": json.loads(f.reasons or "[]"),
        "manually_corrected": f.manually_corrected,
        "box": load_value(f.box),
        "box_verified": bool(f.box_verified),
        "original": load_value(f.raw_value),
        "version": f.version or 0,
    }


def load_list(v: Optional[str]) -> List[Any]:
    try:
        out = json.loads(v or "[]")
    except ValueError:
        return []
    return out if isinstance(out, list) else []


def is_skipped(fm: Form) -> bool:
    """A page that was not read: not a commitment (or blank). Listed apart, never in queues or export."""
    from pipeline.base import SKIPPED_TYPES

    return (fm.doc_type or "commitment") in SKIPPED_TYPES


def rule_names(s: Session) -> Dict[str, str]:
    """Labels for `rule:<id>` reasons, so the UI can say which rule flagged a field."""
    return {f"rule:{r.id}": r.name for r in s.exec(select(ValidationRule)).all()}


def batch_detail(s: Session, batch: Batch) -> Dict[str, Any]:
    # Polled every second: never load the image / file blobs (served by their own endpoints).
    files = s.exec(select(SourceFile).where(SourceFile.batch_id == batch.id)
                   .options(defer(SourceFile.content)).order_by(SourceFile.id)).all()
    names = {f.id: f.filename for f in files}
    forms = s.exec(
        select(Form).where(Form.batch_id == batch.id).options(defer(Form.image_data))
        .order_by(Form.source_file_id, Form.page_index)
    ).all()
    form_ids = [f.id for f in forms]
    fields_by_form: Dict[int, Dict[str, Any]] = {i: {} for i in form_ids}
    if form_ids:
        for fld in s.exec(select(Field).where(Field.form_id.in_(form_ids))).all():
            fields_by_form[fld.form_id][fld.name] = field_dict(fld)

    counts = {"ok": 0, "review": 0, "empty": 0}
    for fm in fields_by_form.values():
        for fd in fm.values():
            counts[fd["level"]] = counts.get(fd["level"], 0) + 1

    children: Dict[int, List[int]] = {}
    for fm in forms:
        if fm.parent_form_id is not None:
            children.setdefault(fm.parent_form_id, []).append(fm.id)

    def file_stats(file_id: int) -> Dict[str, Any]:
        fms = [fm for fm in forms if fm.source_file_id == file_id]
        read = [fm for fm in fms if not is_skipped(fm) and fm.parent_form_id is None]
        flds = [fd for fm in read for fd in fields_by_form[fm.id].values() if fd]
        confs = [fd["confidence"] for fd in flds if fd["value"] is not None]
        return {
            "pages_total": len(fms),
            "pages_done": sum(1 for fm in fms if fm.status in ("done", "failed")),
            "fields_total": len(read) * len([n for n in FIELD_NAMES if n not in OPTIONAL_FIELDS]),
            "fields_extracted": sum(1 for fd in flds if fd["value"] is not None),
            "avg_confidence": round(sum(confs) / len(confs), 4) if confs else None,
        }

    return {
        "id": batch.id,
        "created_at": batch.created_at.isoformat(),
        "status": batch.status,
        "uploaded_by": batch.uploaded_by,
        "paused": control.is_paused(batch.id),
        "notice": batch.notice,
        "expected_files": batch.expected_files,
        "files": [
            {"id": f.id, "filename": f.filename, "status": f.status, "progress": f.progress,
             "error": f.error, "error_code": f.error_code, "warnings": load_list(f.warnings),
             "duplicate_of_batch": f.duplicate_of_batch, **file_stats(f.id)}
            for f in files
        ],
        "forms": [
            {
                "id": fm.id,
                "source_file_id": fm.source_file_id,
                "filename": names.get(fm.source_file_id, ""),
                "page_index": fm.page_index,
                "status": fm.status,
                "error": fm.error,
                "workflow": fm.workflow,
                "assigned_to": fm.assigned_to,
                "approver_comment": fm.approver_comment,
                "error_code": fm.error_code,
                "doc_type": fm.doc_type or "commitment",
                "reasons": load_list(fm.reasons),
                "parent_form_id": fm.parent_form_id,
                "page_ids": [fm.id] + children.get(fm.id, []),
                "region_index": fm.region_index,
                "started_at": fm.started_at.isoformat() if fm.started_at else None,
                "refining": bool(fm.refining),
                "image_rev": fm.image_rev or 0,
                "patient_id": fm.patient_id,
                "patient_link": fm.patient_link,
                "doc_meta": load_value(fm.doc_meta),
                "fields": {n: fields_by_form[fm.id].get(n) for n in FIELD_NAMES},
            }
            for fm in forms
        ],
        "counts": counts,
        "rule_names": rule_names(s),
        "failed_forms": sum(1 for fm in forms if fm.status == "failed"),
        "skipped_forms": sum(1 for fm in forms if fm.status == "done" and is_skipped(fm)),
    }


def _exportable(batch_id: int):
    """Only approved forms leave the system."""
    return select(Form).where(Form.batch_id == batch_id, Form.status == "done", Form.workflow == APPROVED)


def export_rows(s: Session, batch_id: int) -> List[Dict[str, Any]]:
    forms = s.exec(
        _exportable(batch_id)
        .order_by(Form.source_file_id, Form.page_index)
    ).all()
    rows = []
    for fm in forms:
        flds = s.exec(select(Field).where(Field.form_id == fm.id)).all()
        row = {fld.name: load_value(fld.value) for fld in flds}
        confs = [f.confidence for f in flds if f.value is not None]
        row["_form_id"] = fm.id
        row["_review"] = sum(1 for f in flds if f.level == "review")
        row["_confidence"] = round(sum(confs) / len(confs), 4) if confs else None
        rows.append(row)
    return rows


def export_stats(s: Session, batch_id: int) -> Dict[str, Any]:
    """Aggregate numbers for the export screen: fields by level, average confidence, files."""
    form_ids = [f.id for f in s.exec(
        select(Form).where(Form.batch_id == batch_id, Form.status == "done")).all()]
    levels = {"ok": 0, "review": 0, "empty": 0}
    confs: List[float] = []
    if form_ids:
        for fld in s.exec(select(Field).where(Field.form_id.in_(form_ids))).all():
            levels[fld.level] = levels.get(fld.level, 0) + 1
            if fld.value is not None:
                confs.append(fld.confidence)
    files = s.exec(select(SourceFile).where(SourceFile.batch_id == batch_id)).all()
    # pages not read (other documents, blank) and pages merged into another form are never approved on their own
    pages = [(fm.status, fm.workflow) for fm in s.exec(select(Form).where(Form.batch_id == batch_id)).all()
             if fm.parent_form_id is None and not is_skipped(fm)]
    return {
        "files": len(files),
        "pages": len(pages),
        "pages_done": sum(1 for st, _ in pages if st == "done"),
        "approved": sum(1 for st, wf in pages if st == "done" and wf == APPROVED),
        "unapproved": sum(1 for st, wf in pages if st == "done" and wf != APPROVED),
        "source_formats": source_formats([f.filename for f in files]),
        "fields": levels,
        "avg_confidence": round(sum(confs) / len(confs), 4) if confs else None,
    }


_EXT_LABEL = {"jpeg": "JPG", "tif": "TIFF", "heif": "HEIC"}


def source_formats(filenames: List[str]) -> List[str]:
    """Upload formats in first-seen order, e.g. ['PDF', 'TIFF']."""
    out: List[str] = []
    for name in filenames:
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        label = _EXT_LABEL.get(ext, ext.upper())
        if label and label not in out:
            out.append(label)
    return out


def confidence_rows(s: Session, batch_id: int) -> List[Dict[str, Any]]:
    """One row per approved form: filename, page and the level/confidence of every field."""
    names = {f.id: f.filename for f in s.exec(select(SourceFile).where(SourceFile.batch_id == batch_id)).all()}
    forms = s.exec(
        _exportable(batch_id)
        .order_by(Form.source_file_id, Form.page_index)
    ).all()
    out = []
    for fm in forms:
        flds = {f.name: f for f in s.exec(select(Field).where(Field.form_id == fm.id)).all()}
        out.append({
            "filename": names.get(fm.source_file_id, ""),
            "page": fm.page_index + 1,
            "fields": {n: {"level": f.level, "confidence": f.confidence,
                           "manually_corrected": f.manually_corrected} for n, f in flds.items()},
        })
    return out
