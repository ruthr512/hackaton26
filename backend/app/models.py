from datetime import datetime
from typing import Optional

from sqlalchemy import Column
from sqlmodel import Field as SQLField, SQLModel

from app.crypto import EncryptedBlob


class Batch(SQLModel, table=True):
    id: Optional[int] = SQLField(default=None, primary_key=True)
    created_at: datetime = SQLField(default_factory=datetime.utcnow)
    status: str = "processing"  # processing | done
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    uploaded_by: Optional[int] = SQLField(default=None, foreign_key="user.id", index=True)
    expected_files: Optional[int] = None  # per-file upload: the batch is done once this many files arrived and finished
    notice: Optional[str] = None  # batch-wide problem shown to the user, e.g. api_unavailable


class SourceFile(SQLModel, table=True):
    id: Optional[int] = SQLField(default=None, primary_key=True)
    batch_id: int = SQLField(foreign_key="batch.id", index=True)
    filename: str
    path: str
    mime: str = ""
    status: str = "pending"  # pending | processing | done | failed
    progress: float = 0.0  # 0..1
    error: Optional[str] = None
    error_code: Optional[str] = None  # stable code the UI translates (empty_file, corrupt_file, ...)
    warnings: str = "[]"  # JSON list of codes: the file was read, but something is off (pages_missing, ...)
    sha256: Optional[str] = SQLField(default=None, index=True)
    duplicate_of_batch: Optional[int] = None  # the same file was already uploaded in this batch
    pages_total: Optional[int] = None
    content: Optional[bytes] = SQLField(default=None, sa_column=Column(EncryptedBlob))  # the uploaded file itself (AES-256-GCM at rest)


class Form(SQLModel, table=True):
    id: Optional[int] = SQLField(default=None, primary_key=True)
    batch_id: int = SQLField(foreign_key="batch.id", index=True)
    source_file_id: int = SQLField(foreign_key="sourcefile.id", index=True)
    page_index: int = 0
    image_path: str = ""  # working copy on disk while the batch is processed
    image_data: Optional[bytes] = SQLField(default=None, sa_column=Column(EncryptedBlob))  # page image (PNG), AES-256-GCM at rest
    status: str = "pending"  # pending | processing | done | failed  (pipeline state)
    error: Optional[str] = None
    error_code: Optional[str] = None
    # commitment | continuation (merged into the form before it) | other_medical | unrelated | blank
    doc_type: str = "commitment"
    reasons: str = "[]"  # JSON list of form-level codes (multiple_commitments, poor_quality, merged_pages, ...)
    parent_form_id: Optional[int] = SQLField(default=None, index=True)  # set on a continuation page merged into its parent
    region_index: Optional[int] = None  # one of several commitments cut from the same page
    region_box: Optional[str] = None  # JSON [x0, y0, x1, y1] of that region on the page
    premerge_fields: Optional[str] = None  # JSON snapshot of the fields before a merge, restored by split
    started_at: Optional[datetime] = None
    # approval workflow, set once the pipeline is done: needs_fix | pending_approval | returned | approved
    workflow: Optional[str] = SQLField(default=None, index=True)
    assigned_to: Optional[int] = SQLField(default=None, foreign_key="user.id", index=True)
    approver_comment: Optional[str] = None
    created_at: datetime = SQLField(default_factory=datetime.utcnow)
    # shown for review already; zoomed checks still running in the background (fields nobody touched may update)
    refining: bool = False
    # bumped whenever image_data is replaced (page turned / straightened): part of the image URL, so a browser
    # never keeps showing the page as it was before, while the frames are drawn for the turned one
    image_rev: int = 0
    # patient file: normalized 9-digit ID; auto (valid, read with confidence) | suggested | manual | rejected
    patient_id: Optional[str] = SQLField(default=None, index=True)
    patient_link: Optional[str] = None
    # what was read from a non-commitment page (referral...): JSON {id_number, full_name, doc_date, doc_kind, ...}
    doc_meta: Optional[str] = None


class Field(SQLModel, table=True):
    id: Optional[int] = SQLField(default=None, primary_key=True)
    form_id: int = SQLField(foreign_key="form.id", index=True)
    name: str
    value: Optional[str] = None  # JSON-encoded (str or list[str]) or None
    raw_value: Optional[str] = None
    confidence: float = 0.0
    level: str = "empty"  # ok | review | empty
    reasons: str = "[]"  # JSON list of {kind, code}
    manually_corrected: bool = False
    box: Optional[str] = None  # JSON [x0, y0, x1, y1], fractions of the page image
    box_verified: bool = False  # tightened on a zoomed crop that read the same value
    version: int = 0  # bumped on every save: a stale edit is refused instead of silently overwriting


class Correction(SQLModel, table=True):
    """A human fix of what the model read: the raw material pipeline.learning turns into lessons.

    One row per corrected field. It only becomes a lesson once its form is approved (a second pair of eyes).
    field_id is cleared when the form is re-read, since that Field row is replaced; the lesson itself stays.
    """
    id: Optional[int] = SQLField(default=None, primary_key=True)
    created_at: datetime = SQLField(default_factory=datetime.utcnow)
    form_id: int = SQLField(foreign_key="form.id", index=True)
    field_id: Optional[int] = SQLField(default=None, index=True)
    field_name: str = SQLField(index=True)
    model_value: Optional[str] = None  # JSON: what the pipeline showed before the human touched it
    raw_value: Optional[str] = None  # JSON: what the model literally read
    corrected_value: Optional[str] = None  # JSON: what the human says is right
    model_level: str = "review"  # level the pipeline gave it: "ok" means a confident mistake
    model_confidence: float = 0.0
    handwritten: bool = False
    user_id: Optional[int] = SQLField(default=None, foreign_key="user.id")


class PatientName(SQLModel, table=True):
    """The name a person confirmed for a patient (ID) when a commitment came with another one: it replaces the
    names read on the earlier forms, which keep what they say."""
    patient_id: str = SQLField(primary_key=True)
    full_name: str
    previous_names: str = "[]"  # JSON list, newest last
    changed_at: datetime = SQLField(default_factory=datetime.utcnow)
    changed_by: Optional[int] = SQLField(default=None, foreign_key="user.id")


class ExportSetting(SQLModel, table=True):
    """The export options chosen for a batch (the password is never stored)."""
    batch_id: int = SQLField(foreign_key="batch.id", primary_key=True)
    format: str = "xlsx"  # xlsx | csv | json
    include_details: bool = True  # confidence sheet
    include_source_links: bool = True  # link to the scanned page next to every row
    password_protect: bool = False


class ExportRecord(SQLModel, table=True):
    """One row per downloaded export file (metadata only, the file itself is not kept)."""
    id: Optional[int] = SQLField(default=None, primary_key=True)
    batch_id: int = SQLField(foreign_key="batch.id", index=True)
    created_at: datetime = SQLField(default_factory=datetime.utcnow)
    format: str
    filename: str
    size_bytes: int
    sha256: str
    rows: int = 0
    protected: bool = False


class ConfigEntry(SQLModel, table=True):
    """Mappings and layouts (export columns, sender aliases, pipeline) kept in the DB; seeded from config/*.yaml."""
    name: str = SQLField(primary_key=True)  # export | senders | pipeline
    data: str  # JSON
    updated_at: datetime = SQLField(default_factory=datetime.utcnow)


class User(SQLModel, table=True):
    id: Optional[int] = SQLField(default=None, primary_key=True)
    username: str = SQLField(index=True, sa_column_kwargs={"unique": True})
    display_name: str = ""
    role: str = "intake"  # primary role (kept for compatibility): admin | lab_manager | approver | intake
    roles: str = "[]"  # JSON list of every role the user holds; empty = [role]
    password_hash: str = ""
    active: bool = True  # False = deactivated (soft delete: history and assignments stay)
    token_version: int = 0  # bumped on password reset / role change / deactivation: older tokens stop working
    created_at: Optional[datetime] = SQLField(default_factory=datetime.utcnow)
    updated_at: Optional[datetime] = None
    last_login_at: Optional[datetime] = None


class AuditLog(SQLModel, table=True):
    """Who changed what and when: every workflow transition and field mutation (values live in the DB, never in logs)."""
    id: Optional[int] = SQLField(default=None, primary_key=True)
    at: datetime = SQLField(default_factory=datetime.utcnow, index=True)
    user_id: Optional[int] = SQLField(default=None, foreign_key="user.id", index=True)
    action: str = SQLField(index=True)  # status_change | field_corrected | field_approved | field_reset | assigned
    entity: str  # form | field | batch
    entity_id: int = SQLField(index=True)
    form_id: Optional[int] = SQLField(default=None, index=True)  # the form the entity belongs to
    before: Optional[str] = None  # JSON
    after: Optional[str] = None  # JSON
    comment: Optional[str] = None


class ValidationRule(SQLModel, table=True):
    """A rule the lab manager wrote in plain Hebrew, kept with the structured form it was turned into."""
    id: Optional[int] = SQLField(default=None, primary_key=True)
    name: str = ""
    source_text: str = ""  # what the manager wrote
    spec: str = "{}"  # JSON: {combine, when: [...], then: {...}} (validators/rules.py)
    status: str = SQLField(default="draft", index=True)  # draft | active | disabled
    version: int = 1
    created_by: Optional[int] = SQLField(default=None, foreign_key="user.id")
    activated_by: Optional[int] = SQLField(default=None, foreign_key="user.id")
    created_at: datetime = SQLField(default_factory=datetime.utcnow)
    updated_at: Optional[datetime] = None
    last_dry_run: Optional[str] = None  # JSON {checked, flagged, at}
