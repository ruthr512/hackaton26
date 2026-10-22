from datetime import datetime, timedelta

import pytest
from cryptography.exceptions import InvalidTag
from sqlmodel import Session

from app import crypto, db, retention
from app.models import Batch, ExportRecord, Form, SourceFile


def _batch(s, workflow="approved"):
    b = Batch(status="done")
    s.add(b)
    s.commit()
    s.refresh(b)
    sf = SourceFile(batch_id=b.id, filename="a.pdf", path="x", content=b"%PDF-secret")
    s.add(sf)
    s.commit()
    s.refresh(sf)
    s.add(Form(batch_id=b.id, source_file_id=sf.id, status="done", workflow=workflow, image_data=b"\x89PNG-secret"))
    s.commit()
    return b.id


def test_roundtrip_and_tamper(tmp_env):
    blob = crypto.encrypt_bytes(b"patient scan")
    assert b"patient scan" not in blob and blob.startswith(crypto.MAGIC)
    assert crypto.decrypt_bytes(blob) == b"patient scan"
    assert crypto.decrypt_bytes(b"plain legacy") == b"plain legacy"
    bad = bytearray(blob)
    bad[-1] ^= 1
    with pytest.raises(InvalidTag):
        crypto.decrypt_bytes(bytes(bad))


def test_scans_are_encrypted_in_the_db_file(tmp_env):
    with Session(db.get_engine()) as s:
        bid = _batch(s)
    with db.get_engine().connect() as conn:
        raw_sf = conn.exec_driver_sql("SELECT content FROM sourcefile").scalar()
        raw_form = conn.exec_driver_sql("SELECT image_data FROM form").scalar()
    assert b"secret" not in bytes(raw_sf) and b"secret" not in bytes(raw_form)
    with Session(db.get_engine()) as s:
        assert s.get(SourceFile, 1).content == b"%PDF-secret" and s.get(Form, 1).image_data == b"\x89PNG-secret"
    assert bid == 1


def test_legacy_plaintext_rows_get_encrypted(tmp_env):
    with Session(db.get_engine()) as s:
        _batch(s)
    with db.get_engine().begin() as conn:
        conn.exec_driver_sql("UPDATE form SET image_data = ?", (b"\x89PNG-legacy",))
    db.encrypt_legacy_blobs()
    with db.get_engine().connect() as conn:
        assert bytes(conn.exec_driver_sql("SELECT image_data FROM form").scalar()).startswith(crypto.MAGIC)
    with Session(db.get_engine()) as s:
        assert s.get(Form, 1).image_data == b"\x89PNG-legacy"


def _export(s, bid, age_minutes):
    s.add(ExportRecord(batch_id=bid, format="xlsx", filename="f", size_bytes=1, sha256="x",
                       created_at=datetime.utcnow() - timedelta(minutes=age_minutes)))
    s.commit()


def test_scans_deleted_an_hour_after_export(tmp_env):
    with Session(db.get_engine()) as s:
        recent, old, never = _batch(s), _batch(s), _batch(s)
        _export(s, recent, 59)
        _export(s, old, 61)
    assert retention.purge_expired() == [old]
    with Session(db.get_engine()) as s:
        assert s.get(Form, 2).image_data is None and s.get(SourceFile, 2).content is None
        assert s.get(Form, 1).image_data and s.get(Form, 3).image_data
        assert s.get(Form, 2).workflow == "approved"  # the extracted data stays


def test_scans_kept_while_review_is_open(tmp_env):
    with Session(db.get_engine()) as s:
        bid = _batch(s, workflow="pending_approval")
        _export(s, bid, 120)
    assert retention.purge_expired() == []
