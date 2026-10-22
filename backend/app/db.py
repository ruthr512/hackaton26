from typing import Iterator

from sqlmodel import Session, SQLModel, create_engine

from app.config import get_settings

_engine = None


def get_engine():
    global _engine
    if _engine is None:
        s = get_settings()
        s.data_dir.mkdir(parents=True, exist_ok=True)
        _engine = create_engine(
            f"sqlite:///{s.db_path}", connect_args={"check_same_thread": False}
        )
    return _engine


def set_engine(engine) -> None:
    """For tests: swap in an in-memory engine."""
    global _engine
    _engine = engine


def init_db() -> None:
    from app import models  # noqa: F401  (register tables)

    SQLModel.metadata.create_all(get_engine())
    _add_missing_columns()
    seed_config()
    migrate_config()
    migrate_senders()
    migrate_pipeline_config()
    migrate_pipeline_speed()
    migrate_identity()
    migrate_confidence_bands()
    backfill_blobs()
    encrypt_legacy_blobs()
    seed_users()
    migrate_user_roles()
    ensure_admin()
    backfill_workflow()
    backfill_patients()


def _add_missing_columns() -> None:
    """create_all never alters existing tables: add columns introduced after a DB was created."""
    new_columns = {
        "field": {"box": "TEXT", "box_verified": "BOOLEAN DEFAULT 0", "version": "INTEGER DEFAULT 0"},
        "batch": {"started_at": "DATETIME", "finished_at": "DATETIME", "uploaded_by": "INTEGER",
                  "expected_files": "INTEGER", "notice": "VARCHAR"},
        "sourcefile": {"content": "BLOB", "error_code": "VARCHAR", "warnings": "VARCHAR DEFAULT '[]'",
                       "sha256": "VARCHAR", "duplicate_of_batch": "INTEGER", "pages_total": "INTEGER"},
        "form": {"image_data": "BLOB", "workflow": "VARCHAR", "assigned_to": "INTEGER",
                 "approver_comment": "VARCHAR", "created_at": "DATETIME", "error_code": "VARCHAR",
                 "doc_type": "VARCHAR DEFAULT 'commitment'", "reasons": "VARCHAR DEFAULT '[]'",
                 "parent_form_id": "INTEGER", "region_index": "INTEGER", "region_box": "VARCHAR",
                 "premerge_fields": "VARCHAR", "started_at": "DATETIME", "refining": "BOOLEAN DEFAULT 0",
                 "patient_id": "VARCHAR", "patient_link": "VARCHAR", "doc_meta": "VARCHAR",
                 "image_rev": "INTEGER DEFAULT 0"},
        "user": {"roles": "VARCHAR DEFAULT '[]'", "token_version": "INTEGER DEFAULT 0",
                 "created_at": "DATETIME", "updated_at": "DATETIME", "last_login_at": "DATETIME"},
    }
    with get_engine().begin() as conn:
        for table, cols in new_columns.items():
            have = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
            for name, ddl in cols.items():
                if name not in have:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
        conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_form_patient_id ON form (patient_id)")


def seed_config() -> None:
    """Copy config/*.yaml into the DB the first time (afterwards the DB is the source of truth)."""
    import json
    from app.models import ConfigEntry

    s = get_settings()
    with Session(get_engine()) as session:
        for name in ("export", "senders", "pipeline"):
            if session.get(ConfigEntry, name) is None:
                session.add(ConfigEntry(name=name, data=json.dumps(s._yaml(f"{name}.yaml"), ensure_ascii=False)))
        session.commit()


def migrate_senders() -> None:
    """Stored sender list from before the full hospital list: add the names it lacks.

    Applied once (marked in `_migrations`), so a name the manager later removes does not come back.
    """
    import json
    from app.models import ConfigEntry
    from validators.senders import merge_defaults

    mark = "full_list"
    with Session(get_engine()) as session:
        row = session.get(ConfigEntry, "senders")
        if row is None:
            return
        data = json.loads(row.data or "{}")
        done = data.setdefault("_migrations", [])
        if mark in done:
            return
        merge_defaults(data, get_settings()._yaml("senders.yaml"))
        done.append(mark)
        row.data = json.dumps(data, ensure_ascii=False)
        session.add(row)
        session.commit()


def migrate_pipeline_config() -> None:
    """Stored pipeline from before the localize stage: add it (after normalize) and its defaults."""
    import json
    from app.models import ConfigEntry

    stage = "pipeline.stages.localize:Localize"
    with Session(get_engine()) as session:
        row = session.get(ConfigEntry, "pipeline")
        if row is None:
            return
        data = json.loads(row.data or "{}")
        stages = data.get("stages") or []
        if not stages or stage in stages:
            return
        after = "pipeline.stages.normalize:Normalize"
        stages.insert(stages.index(after) + 1 if after in stages else len(stages), stage)
        data["stages"] = stages
        data.setdefault("localize", {"enabled": True, "margin": 0.06})
        data.setdefault("orientation", {"enabled": True})
        row.data = json.dumps(data, ensure_ascii=False)
        session.add(row)
        session.commit()


SPEED_DEFAULTS = {
    "models": {"classify": "claude-haiku-5-5", "localize": "claude-haiku-5-5", "document": "claude-haiku-5-5",
               "extract": None, "double_check": None, "rules": None},
    "early_save": {"enabled": True, "after": "validate"},
    "documents": {"read": True},
}


def migrate_pipeline_speed() -> None:
    """Stored pipeline from before roadmap 2ד: model per stage, early save, more parallel calls, validate first.

    Applied once (marked in `_migrations`), so later edits by the manager are never overwritten.
    """
    import json
    from app.models import ConfigEntry

    mark = "speed_2d"
    with Session(get_engine()) as session:
        row = session.get(ConfigEntry, "pipeline")
        if row is None:
            return
        data = json.loads(row.data or "{}")
        done = data.setdefault("_migrations", [])
        if mark in done:
            return
        for key, value in SPEED_DEFAULTS.items():
            data.setdefault(key, value)
        extract = data.setdefault("extract", {})
        if extract.get("concurrency", 5) <= 5:
            extract["concurrency"] = 16
        extract.setdefault("adaptive", True)
        stages = data.get("stages") or []
        validate, localize = "pipeline.stages.validate:Validate", "pipeline.stages.localize:Localize"
        if validate in stages and localize in stages and stages.index(validate) > stages.index(localize):
            stages.remove(validate)
            stages.insert(stages.index(localize), validate)
        done.append(mark)
        row.data = json.dumps(data, ensure_ascii=False)
        session.add(row)
        session.commit()


def migrate_identity() -> None:
    """Stored pipeline from before the identity cross-check: confidence threshold 0.85 -> 0.65, plus its defaults.

    Applied once (marked in `_migrations`). A threshold the manager already changed to something else is kept.
    """
    import json
    from app.models import ConfigEntry

    mark = "identity_65"
    with Session(get_engine()) as session:
        row = session.get(ConfigEntry, "pipeline")
        if row is None:
            return
        data = json.loads(row.data or "{}")
        done = data.setdefault("_migrations", [])
        if mark in done:
            return
        confidence = data.setdefault("confidence", {})
        if confidence.get("threshold", 0.85) == 0.85:
            confidence["threshold"] = 0.65
        data.setdefault("identity", {"id_min_confidence": 0.70, "name_match": 75})
        confidence.setdefault("handwriting_threshold", 0.80)
        done.append(mark)
        row.data = json.dumps(data, ensure_ascii=False)
        session.add(row)
        session.commit()


CONFIDENCE_BANDS = {"empty_below": 0.50, "review_below": 0.80, "agree_bonus": 0.15, "disagree_cap": 0.60,
                    "misread_cap": 0.60, "doubt_cap": 0.70, "unverified_cap": 0.79}


def migrate_confidence_bands() -> None:
    """Stored pipeline from before the confidence bands: under 50% empty, 50-80% review, from 80% approved.

    Applied once (marked in `_migrations`). The old thresholds go; the old name threshold moves to the identity
    settings (where it is still used), and every value is read a second time.
    """
    import json
    from app.models import ConfigEntry

    mark = "bands_50_80"
    with Session(get_engine()) as session:
        row = session.get(ConfigEntry, "pipeline")
        if row is None:
            return
        data = json.loads(row.data or "{}")
        done = data.setdefault("_migrations", [])
        if mark in done:
            return
        old = data.get("confidence") or {}
        identity = data.setdefault("identity", {"id_min_confidence": 0.70, "name_match": 75})
        identity.setdefault("name_min_confidence", float(old.get("threshold", 0.65)))
        data["confidence"] = dict(CONFIDENCE_BANDS)
        data.setdefault("double_check", {"enabled": True}).setdefault("scope", "all")
        data.setdefault("extract", {}).setdefault("verifier", None)
        done.append(mark)
        row.data = json.dumps(data, ensure_ascii=False)
        session.add(row)
        session.commit()


def migrate_config() -> None:
    """Stored export layouts from before full_name: first_name/last_name columns become one full_name column."""
    import json
    from app.models import ConfigEntry

    with Session(get_engine()) as session:
        row = session.get(ConfigEntry, "export")
        if row is None:
            return
        data = json.loads(row.data or "{}")
        columns = data.get("columns") or []
        old = {"first_name", "last_name"}
        if not any(c.get("field") in old for c in columns):
            return
        out = []
        for c in columns:
            if c.get("field") in old:
                if not any(o.get("field") == "full_name" for o in out):
                    out.append({"field": "full_name", "header": "שם מלא"})
            else:
                out.append(c)
        data["columns"] = out
        row.data = json.dumps(data, ensure_ascii=False)
        session.add(row)
        session.commit()


def backfill_blobs() -> None:
    """Files and page images of batches created before blobs lived in the DB: read them from disk once."""
    from pathlib import Path
    from sqlmodel import select
    from app.models import Form, SourceFile

    with Session(get_engine()) as session:
        for sf in session.exec(select(SourceFile).where(SourceFile.content == None)).all():  # noqa: E711
            if sf.path and Path(sf.path).is_file():
                sf.content = Path(sf.path).read_bytes()
                session.add(sf)
        for fm in session.exec(select(Form).where(Form.image_data == None)).all():  # noqa: E711
            if fm.image_path and Path(fm.image_path).is_file():
                fm.image_data = Path(fm.image_path).read_bytes()
                session.add(fm)
        session.commit()


def encrypt_legacy_blobs() -> None:
    """Scans stored in plain text by earlier versions are encrypted once (rows already starting with the magic are skipped)."""
    from app.crypto import MAGIC, encrypt_bytes

    with get_engine().begin() as conn:
        for table, col in (("sourcefile", "content"), ("form", "image_data")):
            rows = conn.exec_driver_sql(f"SELECT id, {col} FROM {table} WHERE {col} IS NOT NULL").all()
            for row_id, blob in rows:
                if not bytes(blob).startswith(MAGIC):
                    conn.exec_driver_sql(f"UPDATE {table} SET {col} = ? WHERE id = ?", (encrypt_bytes(bytes(blob)), row_id))


DEMO_USERS = [
    ("intake1", "רותי כהן", "intake"),
    ("intake2", "דנה מזרחי", "intake"),
    ("approver1", "יעל לוי", "approver"),
    ("manager1", "ד״ר מיכל לוי", "lab_manager"),
]


def seed_users() -> None:
    """First run: one demo user per role (password DEMO_PASSWORD from .env)."""
    from sqlmodel import select
    from app.auth import hash_password
    from app.models import User

    with Session(get_engine()) as session:
        if session.exec(select(User.id)).first() is not None:
            return
        pw = get_settings().demo_password
        for username, name, role in DEMO_USERS:
            session.add(User(username=username, display_name=name, role=role, roles=f'["{role}"]',
                             password_hash=hash_password(pw)))
        session.commit()


def backfill_workflow() -> None:
    """Forms finished before the approval workflow existed get the same starting state as new ones."""
    from sqlmodel import select
    from app.models import Field, Form
    from app.workflow import initial_workflow

    with get_engine().begin() as conn:  # forms from before created_at existed: use their batch's time
        conn.exec_driver_sql(
            "UPDATE form SET created_at = (SELECT created_at FROM batch WHERE batch.id = form.batch_id) "
            "WHERE created_at IS NULL"
        )
    with Session(get_engine()) as session:
        forms = session.exec(select(Form).where(Form.status == "done", Form.workflow == None)).all()  # noqa: E711
        for fm in forms:
            levels = session.exec(select(Field.level).where(Field.form_id == fm.id)).all()
            fm.workflow = initial_workflow(levels)
            session.add(fm)
        session.commit()


def migrate_user_roles() -> None:
    """Users from before multi-role: their single role becomes their role list."""
    import json
    from sqlmodel import select
    from app.models import User

    with Session(get_engine()) as session:
        for u in session.exec(select(User)).all():
            if not json.loads(u.roles or "[]"):
                u.roles = json.dumps([u.role])
                session.add(u)
        session.commit()


def ensure_admin() -> None:
    """There is always someone who can manage users: create admin1 (DEMO_PASSWORD) if no active admin exists."""
    import json
    from sqlmodel import select
    from app.auth import ROLE_ADMIN, hash_password, roles_of
    from app.models import User

    with Session(get_engine()) as session:
        users = session.exec(select(User)).all()
        if any(u.active and ROLE_ADMIN in roles_of(u) for u in users):
            return
        existing = next((u for u in users if u.username == "admin1"), None)
        if existing is not None:
            existing.active = True
            existing.roles = json.dumps(sorted(set(roles_of(existing)) | {ROLE_ADMIN}))
            existing.role = ROLE_ADMIN
            session.add(existing)
        else:
            session.add(User(username="admin1", display_name="מנהל/ת מערכת", role=ROLE_ADMIN,
                             roles=json.dumps([ROLE_ADMIN]), password_hash=hash_password(get_settings().demo_password)))
        session.commit()


def backfill_patients() -> None:
    from app import patients

    with Session(get_engine()) as session:
        patients.backfill(session)


def get_session() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session
