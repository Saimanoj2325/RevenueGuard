"""Per-case mutual exclusion: Redis lock (cross-process) with an in-process asyncio fallback."""
from __future__ import annotations

import asyncio
import os
import socket
import uuid
from contextlib import asynccontextmanager

from ..config import get_settings

LOCK_TTL_MS = 180_000
OWNER_PREFIX = f"{socket.gethostname()}:{os.getpid()}:"
_local: dict[str, asyncio.Lock] = {}
_redis = None
_checked = False


class LockBusy(Exception):
    pass


async def _r():
    global _redis, _checked
    if _checked:
        return _redis
    _checked = True
    if get_settings().inline_worker and os.environ.get("RG_FORCE_REDIS_LOCKS") != "1":
        _redis = None  # single process: local locks suffice
        return None
    try:
        import redis.asyncio as aioredis

        r = aioredis.from_url(get_settings().redis_url, socket_connect_timeout=1.5)
        await asyncio.wait_for(r.ping(), 2)
        _redis = r
    except Exception:  # noqa: BLE001
        _redis = None
    return _redis


@asynccontextmanager
async def case_lock(case_id: str, wait_seconds: float = 60.0):
    r = await _r()
    key = f"rg:lock:case:{case_id}"
    if r is None:
        lock = _local.setdefault(case_id, asyncio.Lock())
        try:
            await asyncio.wait_for(lock.acquire(), wait_seconds)
        except asyncio.TimeoutError as e:
            raise LockBusy(case_id) from e
        try:
            yield
        finally:
            lock.release()
        return
    token = OWNER_PREFIX + uuid.uuid4().hex
    deadline = asyncio.get_running_loop().time() + wait_seconds
    while not await r.set(key, token, nx=True, px=LOCK_TTL_MS):
        if asyncio.get_running_loop().time() > deadline:
            raise LockBusy(case_id)
        await asyncio.sleep(0.25)
    try:
        yield
    finally:
        try:
            if (await r.get(key) or b"").decode() == token:
                await r.delete(key)
        except Exception:  # noqa: BLE001
            pass


async def break_stale_locks_for_host() -> int:
    """After a crash/restart the same host may hold orphaned locks; release them so resume can proceed."""
    r = await _r()
    if r is None:
        return 0
    n = 0
    host = socket.gethostname() + ":"
    async for k in r.scan_iter("rg:lock:case:*"):
        v = (await r.get(k) or b"").decode()
        if v.startswith(host) and not v.startswith(OWNER_PREFIX):
            await r.delete(k)
            n += 1
    return n
