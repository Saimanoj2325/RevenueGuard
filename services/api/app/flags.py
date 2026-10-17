"""Tenant runtime flags (kill switch, chaos toggles, virtual clock) stored in Postgres so API + worker agree."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import utcnow
from .models import KvFlag

KILL_SWITCH = "kill_switch"
CLOCK_OFFSET_HOURS = "clock_offset_hours"
CHAOS_PREFIX = "chaos:"  # chaos:zoho_down, chaos:nim_down, chaos:garbage_output, chaos:kill_worker


async def get_flag(session: AsyncSession, tenant_id: str, key: str, default: Any = None) -> Any:
    row = await session.get(KvFlag, (tenant_id, key))
    return default if row is None else row.value


async def set_flag(session: AsyncSession, tenant_id: str, key: str, value: Any) -> None:
    row = await session.get(KvFlag, (tenant_id, key))
    if row is None:
        session.add(KvFlag(tenant_id=tenant_id, key=key, value=value))
    else:
        row.value = value
    await session.flush()


async def clear_prefix(session: AsyncSession, tenant_id: str, prefix: str) -> None:
    rows = (await session.execute(select(KvFlag).where(KvFlag.tenant_id == tenant_id))).scalars().all()
    for r in rows:
        if r.key.startswith(prefix):
            await session.delete(r)
    await session.flush()


async def chaos_on(session: AsyncSession, tenant_id: str, kind: str) -> bool:
    return bool(await get_flag(session, tenant_id, CHAOS_PREFIX + kind, False))


async def now(session: AsyncSession, tenant_id: str) -> datetime:
    """Virtual clock: real UTC now plus the demo fast-forward offset."""
    off = await get_flag(session, tenant_id, CLOCK_OFFSET_HOURS, 0) or 0
    return utcnow() + timedelta(hours=float(off))
