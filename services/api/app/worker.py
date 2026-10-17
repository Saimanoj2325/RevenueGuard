"""ARQ worker: case advancement jobs, Gmail polling (60s), PAUSED/WATCHING sweeps, resume-on-startup.

Run:  arq app.worker.WorkerSettings
"""
from __future__ import annotations

import asyncio
import os

from arq import cron
from arq.connections import RedisSettings
from sqlalchemy import select

from .config import get_settings
from .db import session_scope
from .observability import configure_logging, get_logger

configure_logging(get_settings().log_level)
log = get_logger("worker")


async def advance_case(ctx, case_id: str) -> str:
    from .orchestrator.engine import WorkerKilled, drive_case
    from .orchestrator.locks import LockBusy

    try:
        return await drive_case(case_id, wait_seconds=5)
    except LockBusy:
        # another worker/API holds this case; retry shortly instead of blocking a worker slot
        await ctx["redis"].enqueue_job("advance_case", case_id, _defer_by=2)
        return "deferred"
    except WorkerKilled:
        log.warning("worker.killed_inline", case_id=case_id)
        os._exit(137)


async def sweep(ctx=None) -> int:
    """Re-check PAUSED cases (connector healthy again?) and WATCHING cases whose timer is due."""
    from .flags import now as vnow
    from .jobs import enqueue_advance
    from .models import Case

    async with session_scope() as s:
        rows = (await s.execute(select(Case).where(Case.state.in_(("PAUSED", "WATCHING"))))).scalars().all()
        due = [c.id for c in rows if c.state == "PAUSED" or (c.watch_until and await vnow(s, c.tenant_id) >= c.watch_until)]
    for cid in due:
        await enqueue_advance(cid)
    try:
        from .intake import reread_pending

        await reread_pending()  # messages that came in while no LLM answered
    except Exception:  # noqa: BLE001
        log.exception("sweep.reread_failed")
    try:
        from .lifecycle import sweep_pending
        from .timeline import retry_pending

        await retry_pending()  # timeline decisions that waited for a model
        await sweep_pending()  # edits/deletes whose message never arrived (10 min)
    except Exception:  # noqa: BLE001
        log.exception("sweep.timeline_failed")
    return len(due)


async def gmail_poll(ctx=None) -> None:
    from .sync import sync_all_gmail

    await sync_all_gmail()


async def run_backfill(ctx, job_id: str) -> dict:
    from .backfill import run_backfill as _run

    return await _run(ctx, job_id)


async def digest_tick(ctx=None) -> int:
    """Daily digest: checked every minute; each tenant sends once per local day at its configured time (default 09:00 IST)."""
    from .notify import digest_all

    return await digest_all(ctx)


async def startup(ctx) -> None:
    os.environ.setdefault("RG_HARD_KILL", "1")  # chaos kill_worker really kills this process; docker restarts it
    from .demo.seed import seed
    from .orchestrator.engine import resume_all

    await seed()
    info = await resume_all()
    log.info("worker.resumed", cases=len(info), detail=info[:20])


async def inline_loops() -> None:
    """INLINE_WORKER=true: run the same periodic jobs inside the API process."""
    s = get_settings()
    from .orchestrator.engine import resume_all

    try:
        await resume_all()
    except Exception:  # noqa: BLE001
        log.exception("inline.resume_failed")
    tick = 0
    while True:
        await asyncio.sleep(30)
        tick += 30
        try:
            await sweep()
            if tick % max(30, s.gmail_poll_seconds) == 0:
                await gmail_poll()
            if tick % 60 == 0:
                await digest_tick()
        except Exception:  # noqa: BLE001
            log.exception("inline.loop_error")


class WorkerSettings:
    functions = [advance_case, run_backfill]
    cron_jobs = [
        cron(gmail_poll, second={0}, run_at_startup=False),  # every 60s
        cron(sweep, second={15, 45}, run_at_startup=False),  # every 30s
        cron(digest_tick, second={30}, run_at_startup=False),  # every minute; sends at tenant time (default 09:00 IST), once a day
    ]
    on_startup = startup
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    max_jobs = 10
    job_timeout = 600
    keep_result = 60
