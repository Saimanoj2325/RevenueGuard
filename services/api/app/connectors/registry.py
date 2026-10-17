"""Connector lookup: tenant-scoped rows + adapter selection (mock in DEMO_MODE or when row.mode == 'mock')."""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import Connector
from .base import CONNECTOR_NAMES, NotConnected


async def get_connector(session: AsyncSession, tenant_id: str, name: str, create: bool = True) -> Connector | None:
    row = (await session.execute(select(Connector).where(Connector.tenant_id == tenant_id, Connector.name == name))).scalar_one_or_none()
    if row is None and create:
        row = Connector(tenant_id=tenant_id, name=name, status="disconnected", mode="mock" if get_settings().demo_mode else "live", config={})
        session.add(row)
        await session.flush()
    return row


async def list_connectors(session: AsyncSession, tenant_id: str) -> list[dict[str, Any]]:
    out = []
    for n in CONNECTOR_NAMES:
        c = await get_connector(session, tenant_id, n)
        cfg = dict(c.config or {})
        cfg.pop("mock", None)
        rows = cfg.pop("rows", None)
        out.append({
            "name": n, "status": c.status, "mode": c.mode, "authorized_by": c.authorized_by,
            "authorized_at": c.authorized_at.isoformat() if c.authorized_at else None,
            "last_sync_at": c.last_sync_at.isoformat() if c.last_sync_at else None, "error": c.error,
            "config": {k: v for k, v in cfg.items() if k in ("spreadsheet_id", "range", "organization_id", "email")},
            **({"rows": len(rows)} if rows is not None else {}),
        })
    return out


async def adapter(session: AsyncSession, tenant_id: str, name: str):
    from . import mock

    conn = await get_connector(session, tenant_id, name)
    if conn.status in ("revoked", "disconnected") and name != "bank":
        raise NotConnected(name)
    use_mock = conn.mode == "mock"
    if name == "gmail":
        if use_mock:
            return mock.MockGmail(session, conn)
        from .google import LiveGmail

        return LiveGmail(session, conn)
    if name == "sheets":
        if use_mock:
            return mock.MockSheets(session, conn)
        from .google import LiveSheets

        return LiveSheets(session, conn)
    if name == "drive":
        if use_mock:
            return mock.MockDrive(session, conn)
        from .google import LiveDrive

        return LiveDrive(session, conn)
    if name == "zoho":
        if use_mock:
            return mock.MockZoho(session, conn, tenant_id)
        from .zoho import LiveZoho

        return LiveZoho(session, conn)
    if name == "whatsapp":
        if use_mock:
            return mock.MockWhatsApp(session, conn, tenant_id)
        from .whatsapp import BridgeWhatsApp

        return BridgeWhatsApp(session, conn, tenant_id)
    if name == "bank":
        from .bank import CsvBank

        return CsvBank(session, conn)
    raise ValueError(f"unknown connector {name}")
