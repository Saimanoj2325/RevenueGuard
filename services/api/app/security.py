"""Passwords, JWT, service-to-service HMAC and Fernet token encryption."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
import jwt
from cryptography.fernet import Fernet, InvalidToken

from .config import get_settings

ROLES = ("viewer", "operator", "finance_approver", "admin")
ROLE_RANK = {r: i for i, r in enumerate(ROLES)}
APPROVER_ROLES = {"finance_approver", "admin"}


# ---------- passwords ----------
def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=10)).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except ValueError:
        return False


# ---------- JWT ----------
def create_token(user_id: str, tenant_id: str, role: str, email: str) -> str:
    s = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "tid": tenant_id,
        "role": role,
        "email": email,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=s.jwt_ttl_minutes)).timestamp()),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> dict[str, Any]:
    return jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])


def sign_state(data: dict[str, Any], ttl: int = 900) -> str:
    """Signed, short-lived OAuth `state` parameter."""
    s = get_settings()
    body = {**data, "exp": int(time.time()) + ttl, "purpose": "oauth_state"}
    return jwt.encode(body, s.jwt_secret, algorithm="HS256")


def verify_state(state: str) -> dict[str, Any]:
    data = jwt.decode(state, get_settings().jwt_secret, algorithms=["HS256"])
    if data.get("purpose") != "oauth_state":
        raise jwt.InvalidTokenError("bad state purpose")
    return data


# ---------- HMAC (service to service) ----------
def hmac_hex(body: bytes, secret: str | None = None) -> str:
    key = (secret or get_settings().internal_hmac_secret).encode()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


def sign_headers(body: bytes, agent: str | None = None) -> dict[str, str]:
    h = {
        "X-RG-Signature": f"sha256={hmac_hex(body)}",
        "X-RG-Timestamp": str(int(time.time())),
        "Content-Type": "application/json",
    }
    if agent:
        h["X-RG-Agent"] = agent
    return h


class HmacError(Exception):
    pass


def verify_hmac(body: bytes, signature: str | None, timestamp: str | None) -> None:
    s = get_settings()
    if not signature or not timestamp:
        raise HmacError("missing signature headers")
    try:
        ts = int(timestamp)
    except ValueError as e:
        raise HmacError("bad timestamp") from e
    if abs(time.time() - ts) > s.hmac_max_skew_seconds:
        raise HmacError("timestamp skew too large")
    expected = f"sha256={hmac_hex(body)}"
    if not hmac.compare_digest(expected, signature.strip()):
        raise HmacError("signature mismatch")


# ---------- Fernet ----------
def _fernet() -> Fernet:
    s = get_settings()
    key = s.fernet_key.strip()
    if not key:
        # deterministic dev fallback derived from JWT secret; production must set FERNET_KEY
        key = base64.urlsafe_b64encode(hashlib.sha256(("fernet:" + s.jwt_secret).encode()).digest()).decode()
    return Fernet(key.encode())


def encrypt_json(data: dict[str, Any]) -> str:
    return _fernet().encrypt(json.dumps(data).encode()).decode()


def decrypt_json(token: str | None) -> dict[str, Any]:
    if not token:
        return {}
    try:
        return json.loads(_fernet().decrypt(token.encode()))
    except InvalidToken:
        return {}


# ---------- canonical hashing ----------
def canonical_json(data: Any) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def payload_hash(data: Any) -> str:
    return hashlib.sha256(canonical_json(data).encode()).hexdigest()


def sha256_text(text: str | bytes) -> str:
    if isinstance(text, str):
        text = text.encode()
    return hashlib.sha256(text).hexdigest()
