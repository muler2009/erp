import base64
import hashlib
import json
import secrets

from cryptography.fernet import Fernet
from django.conf import settings


def _fernet():
    key = settings.TOKEN_ENCRYPTION_KEY
    if not key:  # DEBUG-only fallback; settings refuse to boot without a key otherwise
        key = base64.urlsafe_b64encode(hashlib.sha256(settings.SECRET_KEY.encode()).digest()).decode()
    return Fernet(key)


def encrypt_json(payload: dict) -> str:
    return _fernet().encrypt(json.dumps(payload).encode()).decode()


def decrypt_json(token: str) -> dict:
    return json.loads(_fernet().decrypt(token.encode()))


def new_invite_token() -> str:
    return secrets.token_urlsafe(32)


def hash_invite_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
