"""Append-only, hash-chained audit log (per tenant). DB triggers forbid UPDATE/DELETE on Postgres."""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .db import utcnow
from .models import AuditLog
from .observability import correlation_id_var
from .security import canonical_json, sha256_text

GENESIS = "0" * 64


def _row_hash(prev_hash: str, tenant_id: str, seq: int, case_id, correlation_id, actor, event, data, created_at) -> str:
    body = canonical_json(
        {
            "tenant_id": tenant_id,
            "seq": seq,
            "case_id": case_id,
            "correlation_id": correlation_id,
            "actor": actor,
            "event": event,
            "data": data,
            "created_at": created_at.isoformat(),
        }
    )
    return sha256_text(prev_hash + body)


async def append_audit(
    session: AsyncSession,
    tenant_id: str,
    event: str,
    actor: str,
    data: dict[str, Any] | None = None,
    case_id: str | None = None,
    correlation_id: str | None = None,
) -> AuditLog:
    data = data or {}
    correlation_id = correlation_id or correlation_id_var.get()
    if session.bind.dialect.name == "postgresql":
        await session.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": "audit:" + tenant_id})
    last = (
        await session.execute(
            select(AuditLog.seq, AuditLog.hash).where(AuditLog.tenant_id == tenant_id).order_by(AuditLog.seq.desc()).limit(1)
        )
    ).first()
    pending_seq = getattr(session, "_rg_audit_pending", {}).get(tenant_id)
    if pending_seq is not None and (last is None or pending_seq[0] > last[0]):
        seq, prev = pending_seq[0] + 1, pending_seq[1]
    else:
        seq, prev = ((last[0] + 1), last[1]) if last else (1, GENESIS)
    created = utcnow().replace(microsecond=(utcnow().microsecond // 1000) * 1000)
    data = json.loads(canonical_json(data))
    h = _row_hash(prev, tenant_id, seq, case_id, correlation_id, actor, event, data, created)
    row = AuditLog(
        tenant_id=tenant_id,
        seq=seq,
        case_id=case_id,
        correlation_id=correlation_id,
        actor=actor,
        event=event,
        data=data,
        prev_hash=prev,
        hash=h,
        created_at=created,
    )
    session.add(row)
    await session.flush()
    if not hasattr(session, "_rg_audit_pending"):
        session._rg_audit_pending = {}  # type: ignore[attr-defined]
    session._rg_audit_pending[tenant_id] = (seq, h)  # type: ignore[attr-defined]
    return row


async def verify_chain(session: AsyncSession, tenant_id: str) -> dict[str, Any]:
    rows = (await session.execute(select(AuditLog).where(AuditLog.tenant_id == tenant_id).order_by(AuditLog.seq))).scalars().all()
    prev = GENESIS
    for i, r in enumerate(rows, start=1):
        if r.seq != i or r.prev_hash != prev:
            return {"ok": False, "broken_at_seq": r.seq, "count": len(rows)}
        expected = _row_hash(prev, r.tenant_id, r.seq, r.case_id, r.correlation_id, r.actor, r.event, r.data, r.created_at)
        if expected != r.hash:
            return {"ok": False, "broken_at_seq": r.seq, "count": len(rows)}
        prev = r.hash
    total = (await session.execute(select(func.count()).select_from(AuditLog).where(AuditLog.tenant_id == tenant_id))).scalar()
    return {"ok": True, "count": total, "head": prev}
