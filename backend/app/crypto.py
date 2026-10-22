"""Encryption at rest for the scanned files: AES-256-GCM on the two blob columns that hold patient documents.

Stored value = MAGIC + 12-byte nonce + ciphertext+tag. A value without MAGIC is a row written before encryption
existed: it is read as is and encrypted by `encrypt_legacy_blobs` at startup.
"""
import os
from typing import Dict, Optional, Tuple

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy import LargeBinary
from sqlalchemy.types import TypeDecorator

from app.config import get_settings

MAGIC = b"MSENC1"
_NONCE = 12
_KEYS: Dict[Tuple[str, str], AESGCM] = {}


def _secret() -> str:
    """DATA_ENCRYPTION_KEY from .env; without it a random key is created once and kept next to the database."""
    s = get_settings()
    if s.data_encryption_key:
        return s.data_encryption_key
    keyfile = s.data_dir / "encryption.key"
    if not keyfile.is_file():
        s.data_dir.mkdir(parents=True, exist_ok=True)
        keyfile.write_text(os.urandom(32).hex())
        try:
            keyfile.chmod(0o600)
        except OSError:  # Windows
            pass
    return keyfile.read_text().strip()


def _aes() -> AESGCM:
    secret = _secret()
    cache_key = (secret, str(get_settings().data_dir))
    if cache_key not in _KEYS:
        key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"medscan-files-v1").derive(secret.encode())
        _KEYS[cache_key] = AESGCM(key)
    return _KEYS[cache_key]


def encrypt_bytes(data: bytes) -> bytes:
    nonce = os.urandom(_NONCE)
    return MAGIC + nonce + _aes().encrypt(nonce, data, MAGIC)


def decrypt_bytes(blob: bytes) -> bytes:
    if not blob.startswith(MAGIC):
        return blob  # written before encryption existed
    nonce, body = blob[len(MAGIC):len(MAGIC) + _NONCE], blob[len(MAGIC) + _NONCE:]
    return _aes().decrypt(nonce, body, MAGIC)


def is_encrypted(blob: Optional[bytes]) -> bool:
    return bool(blob) and bytes(blob).startswith(MAGIC)


class EncryptedBlob(TypeDecorator):
    """A BLOB column that is encrypted on write and decrypted on read, invisible to the rest of the code."""
    impl = LargeBinary
    cache_ok = True

    def process_bind_param(self, value, dialect):
        return None if value is None else encrypt_bytes(bytes(value))

    def process_result_value(self, value, dialect):
        return None if value is None else decrypt_bytes(bytes(value))
