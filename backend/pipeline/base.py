"""Pipeline building blocks: FormDoc (working object), Context, Stage protocol."""
import inspect
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Protocol, Union

from pydantic import BaseModel, Field as PField

from app.config import Settings


class FieldResult(BaseModel):
    value: Any = None  # str | list[str] | None
    raw_value: Any = None
    confidence: float = 0.0
    legible: bool = True
    handwritten: bool = False
    box: Optional[List[float]] = None  # normalized [x0, y0, x1, y1] on the page image (drawn in the UI)
    box_verified: bool = False  # box was re-located on a zoomed crop that read the same value
    hint_box: Optional[List[float]] = None  # coarse box from the first read: drawn (dashed) when it could not be verified, and used to cut zoom crops
    level: str = "empty"
    reasons: List[Dict[str, str]] = PField(default_factory=list)
    learned: bool = False  # the value came from a lesson (earlier human corrections), not from the reading

    def add_reason(self, kind: str, code: str, detail: Optional[str] = None) -> None:
        """`detail` is a value the note quotes (e.g. the name an ID is filed under)."""
        if not any(r["code"] == code for r in self.reasons):
            self.reasons.append({"kind": kind, "code": code, **({"detail": detail} if detail else {})})


class FormDoc(BaseModel):
    batch_id: int
    source_file_id: int
    form_id: Optional[int] = None
    file_path: str = ""  # original upload (or converted copy)
    mime: str = ""
    pages: List[str] = PField(default_factory=list)  # rendered page images (pre-split)
    page_index: int = 0
    image_path: str = ""  # this form's page image (post-split)
    form_type: Optional[str] = None
    fields: Dict[str, FieldResult] = PField(default_factory=dict)
    # what the page is: commitment | continuation | other_medical | unrelated | blank (set by classify)
    doc_type: str = "commitment"
    forced_type: Optional[str] = None  # the user overrode the classification: classify keeps this type
    form_reasons: List[str] = PField(default_factory=list)  # form-level review codes
    file_warnings: List[str] = PField(default_factory=list)  # the file was read, but something is off
    region_index: Optional[int] = None
    region_box: Optional[List[float]] = None
    doc_meta: Optional[Dict[str, Any]] = None  # light read of a non-commitment page (referral...): patient file

    def add_form_reason(self, code: str) -> None:
        if code not in self.form_reasons:
            self.form_reasons.append(code)


# Pages that are not read: they are kept (with their image) and listed apart, but get no fields.
SKIPPED_TYPES = ("other_medical", "unrelated", "blank")


class FileProblem(ValueError):
    """A problem with the uploaded file itself, carrying a stable code the UI translates."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


@dataclass
class Context:
    settings: Settings
    pipeline_cfg: Dict[str, Any]
    senders_cfg: Dict[str, Any]
    client: Any  # pipeline.claude_client.ClaudeClient (or a test stub)
    batch_dir: Any = None
    lessons: Any = None  # pipeline.learning.Lessons, learned from human corrections; None = nothing learned
    extras: Dict[str, Any] = field(default_factory=dict)
    models: Dict[str, Optional[str]] = field(default_factory=dict)  # stage -> model id (None = the default model)
    rules: List[Any] = field(default_factory=list)  # active validation rules (app.models.ValidationRule-like)

    async def call_tool(self, stage: str, **kw: Any) -> Dict[str, Any]:
        """Call the client for one stage, on that stage's model when one is configured.

        `model=` is passed only to clients that accept it, so duck-typed test stubs keep working.
        """
        model = self.models.get(stage)
        if model and _accepts_model(self.client):
            kw["model"] = model
        return await self.client.call_tool(**kw)


def _accepts_model(client: Any) -> bool:
    try:
        return "model" in inspect.signature(client.call_tool).parameters
    except (TypeError, ValueError, AttributeError):
        return False


StageResult = Union[FormDoc, List[FormDoc]]


class Stage(Protocol):
    """A pipeline stage. `run` may be sync or async; returning a list fans out."""

    def run(self, form: FormDoc, ctx: Context) -> StageResult: ...
