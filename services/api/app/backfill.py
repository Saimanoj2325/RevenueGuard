"""First-day backfill (ARQ job): pull the last N days from Gmail, watched WhatsApp chats, the delivery Sheet and
Zoho with per-source progress, then point the user at the first real finding."""
from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

from sqlalchemy import select

from .audit import append_audit
from .config import get_settings
from .connectors.base import ConnectorError, NotConnected
from .connectors.registry import adapter, get_connector
from .db import session_scope, utcnow
from .models import BackfillJob
from .observability import get_logger

log = get_logger("backfill")
SOURCES = ("gmail", "whatsapp", "sheets", "zoho")
_tasks: set[asyncio.Task] = set()


def job_json(j: BackfillJob | None) -> dict[str, Any]:
    if j is None:
        return {"job_id": None, "status": "none", "sources": [{"name": n, "done": 0, "total": 0, "status": "not_started"} for n in SOURCES], "first_case_ref": None}
    return {"job_id": j.id, "status": j.status, "days": j.days, "sources": j.sources, "first_case_ref": j.first_case_ref,
            "created_at": j.created_at.isoformat(), "finished_at": j.finished_at.isoformat() if j.finished_at else None, "error": j.error}


async def start_backfill(tenant_id: str, days: int, by: str) -> str:
    async with session_scope() as s:
        j = BackfillJob(tenant_id=tenant_id, days=days, status="queued", created_by=by,
                        sources=[{"name": n, "done": 0, "total": 0, "status": "queued"} for n in SOURCES])
        s.add(j)
        await s.flush()
        await append_audit(s, tenant_id, "setup.backfill_started", by, {"job_id": j.id, "days": days})
        jid = j.id
    st = get_settings()
    if not st.inline_worker:
        from .jobs import get_pool

        pool = await get_pool()
        if pool is not None:
            await pool.enqueue_job("run_backfill", jid)
            return jid
    t = asyncio.create_task(run_backfill(None, jid))
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)
    return jid


async def _set(jid: str, name: str, **kw) -> None:
    async with session_scope() as s:
        j = await s.get(BackfillJob, jid)
        srcs = [dict(x) for x in j.sources]
        for x in srcs:
            if x["name"] == name:
                x.update(kw)
        j.sources = srcs


async def _count(tenant_id: str, name: str, days: int) -> int:
    since = (utcnow() - timedelta(days=days)).isoformat()
    if name == "gmail":
        from .sync import sync_gmail

        r = await sync_gmail(tenant_id)
        if r.get("status") == "not_connected":
            raise NotConnected("gmail")
        if r.get("status") == "error":
            raise ConnectorError("gmail", r.get("error") or "sync failed")
        return int(r.get("fetched") or 0)
    async with session_scope() as s:
        a = await adapter(s, tenant_id, name)
        if name == "whatsapp":
            return len(await a.search(None, None, since))
        if name == "sheets":
            return len(await a.read_delivery(None))
        if name == "zoho":
            return len(await a.list_invoices()) + len(await a.list_salesorders()) + len(await a.list_payments())
    return 0


async def run_backfill(ctx, job_id: str) -> dict[str, Any]:
    async with session_scope() as s:
        j = await s.get(BackfillJob, job_id)
        if j is None:
            return {"error": "job not found"}
        j.status = "running"
        tenant_id, days = j.tenant_id, j.days
    for name in SOURCES:
        await _set(job_id, name, status="running")
        try:
            async with session_scope() as s:
                conn = await get_connector(s, tenant_id, name)
                connected = conn.status == "connected"
            if not connected:
                await _set(job_id, name, status="skipped", error_plain="Not connected yet.")
                continue
            n = await _count(tenant_id, name, days)
            await _set(job_id, name, status="done", done=n, total=n)
        except NotConnected:
            await _set(job_id, name, status="skipped", error_plain="Not connected yet.")
        except ConnectorError as e:
            await _set(job_id, name, status="failed", error_plain=f"Could not read {name}: {str(e)[:120]}")
        except Exception as e:  # noqa: BLE001
            log.exception("backfill.source_failed", source=name)
            await _set(job_id, name, status="failed", error_plain=f"Could not read {name}: {type(e).__name__}")
    from .business import bill_rows, load_world

    async with session_scope() as s:
        w = await load_world(s, tenant_id)
        rows = [r for r in bill_rows(w) if r["status"] in ("not_billed", "partial")]
        j = await s.get(BackfillJob, job_id)
        j.first_case_ref = rows[0]["case_ref"] if rows else None
        j.status = "done"
        j.finished_at = utcnow()
        await append_audit(s, tenant_id, "setup.backfill_done", "backfill", {"job_id": job_id, "sources": j.sources, "first_case_ref": j.first_case_ref})
        return job_json(j)


async def latest(tenant_id: str) -> dict[str, Any]:
    async with session_scope() as s:
        j = (await s.execute(select(BackfillJob).where(BackfillJob.tenant_id == tenant_id).order_by(BackfillJob.created_at.desc()).limit(1))).scalar_one_or_none()
        return job_json(j)


async def wait_idle(timeout: float = 30) -> None:
    if _tasks:
        await asyncio.wait(list(_tasks), timeout=timeout)
