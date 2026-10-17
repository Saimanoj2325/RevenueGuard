"""Object storage for attachments/media: MinIO (S3 API via boto3) with a local-disk backend for dev/tests."""
from __future__ import annotations

import asyncio
import hashlib
import os
import re
from pathlib import Path

from .config import get_settings
from .observability import get_logger

log = get_logger("storage")
_s3 = None
_bucket_ready = False


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)[:120] or "blob"


def object_key(tenant_id: str, filename: str, data: bytes) -> str:
    digest = hashlib.sha256(data).hexdigest()[:16]
    return f"{tenant_id}/{digest}-{_safe(filename)}"


def _client():
    global _s3
    if _s3 is None:
        import boto3
        from botocore.config import Config

        s = get_settings()
        _s3 = boto3.client(
            "s3",
            endpoint_url=s.minio_endpoint,
            aws_access_key_id=s.minio_access_key,
            aws_secret_access_key=s.minio_secret_key,
            region_name="us-east-1",
            config=Config(signature_version="s3v4", connect_timeout=3, read_timeout=10, retries={"max_attempts": 2}),
        )
    return _s3


def _ensure_bucket() -> None:
    global _bucket_ready
    if _bucket_ready:
        return
    c = _client()
    bucket = get_settings().minio_bucket
    try:
        c.head_bucket(Bucket=bucket)
    except Exception:  # noqa: BLE001
        c.create_bucket(Bucket=bucket)
    _bucket_ready = True


def _put_sync(key: str, data: bytes, mime: str) -> None:
    s = get_settings()
    if s.storage_backend == "local":
        p = Path(s.local_storage_dir) / key
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return
    _ensure_bucket()
    _client().put_object(Bucket=s.minio_bucket, Key=key, Body=data, ContentType=mime)


def _get_sync(key: str) -> bytes:
    s = get_settings()
    if s.storage_backend == "local":
        return (Path(s.local_storage_dir) / key).read_bytes()
    return _client().get_object(Bucket=s.minio_bucket, Key=key)["Body"].read()


async def put_bytes(tenant_id: str, filename: str, data: bytes, mime: str) -> str:
    key = object_key(tenant_id, filename, data)
    await asyncio.to_thread(_put_sync, key, data, mime)
    return key


async def get_bytes(key: str) -> bytes:
    return await asyncio.to_thread(_get_sync, key)


def tenant_owns(tenant_id: str, key: str) -> bool:
    return key.startswith(tenant_id + "/") and ".." not in key and not os.path.isabs(key)
