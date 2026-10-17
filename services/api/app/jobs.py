"""Background job dispatch: ARQ (Redis) in production, in-process asyncio tasks when INLINE_WORKER=true."""
from __future__ import annotations

import asyncio
from typing import Any

from .config import get_settings
from .observability import get_logger

log = get_logger("jobs")
_pool = None
_pool_failed = False
_tasks: set[asyncio.Task] = set()
SUPPRESS: dict[str, int] = {"depth": 0}  # demo endpoints drive synchronously and suppress background advancing


async def get_pool():
    global _pool, _pool_failed
    if _pool is not None or _pool_failed:
        return _pool
    try:
        from arq import create_pool
        from arq.connections import RedisSettings

        _pool = await asyncio.wait_for(create_pool(RedisSettings.from_dsn(get_settings().redis_url)), 3)
    except Exception as e:  # noqa: BLE001
        log.warning("jobs.arq_unavailable", error=str(e))
        _pool_failed = True
    return _pool


async def _inline_drive(case_id: str) -> None:
    from .orchestrator.engine import WorkerKilled, drive_case
    from .orchestrator.locks import LockBusy

    for _ in range(20):
        try:
            await drive_case(case_id, wait_seconds=2)
            return
        except LockBusy:
            await asyncio.sleep(1)
        except WorkerKilled as e:
            log.warning("inline.worker_killed", case_id=case_id, error=str(e))
            return
        except Exception:  # noqa: BLE001
            log.exception("inline.drive_failed", case_id=case_id)
            return


async def enqueue_advance(case_id: str, defer_seconds: float = 0) -> dict[str, Any]:
    if SUPPRESS["depth"] > 0:
        return {"mode": "suppressed"}
    s = get_settings()
    if not s.inline_worker:
        pool = await get_pool()
        if pool is not None:
            await pool.enqueue_job("advance_case", case_id, _defer_by=defer_seconds or None)
            return {"mode": "arq"}
    t = asyncio.create_task(_inline_drive(case_id))
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)
    return {"mode": "inline"}


async def wait_inline_idle(timeout: float = 30) -> None:
    """Tests/demo: wait until in-process background tasks finish."""
    if _tasks:
        await asyncio.wait(list(_tasks), timeout=timeout)
