"""Inbound sync: Gmail history-based incremental polling and wa-bridge events -> secure intake."""
from __future__ import annotations

import base64
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from .audit import append_audit
from .connectors.base import ConnectorError
from .connectors.registry import adapter, get_connector
from .db import session_scope, utcnow
from .events import emit
from .intake import IntakeAttachment, IntakeItem, intake
from .models import Connector, Tenant, WaMessage
from .observability import get_logger

log = get_logger("sync")


async def sync_gmail(tenant_id: str, enqueue: bool = True) -> dict[str, Any]:
    async with session_scope() as s:
        conn = await get_connector(s, tenant_id, "gmail")
        if conn.status != "connected":
            return {"status": "not_connected"}
        try:
            a = await adapter(s, tenant_id, "gmail")
            msgs, cursor = await a.list_new_messages(conn.cursor or {})
        except ConnectorError as e:
            conn.error = str(e)[:300]
            await emit(tenant_id, "connector.updated", name="gmail", status="error")
            return {"status": "error", "error": str(e)}
        conn.cursor = cursor
        conn.last_sync_at = utcnow()
        conn.error = None
    results = []
    failed: list[str] = []
    for m in msgs:
        try:
            ts = datetime.fromisoformat(m["date"]) if m.get("date") else None
        except ValueError:
            ts = None
        item = IntakeItem(
            source="gmail", source_id=m["id"], ts=ts, sender=m.get("from", ""), sender_name=m.get("from", "").split("<")[0].strip().strip('"'),
            subject=m.get("subject", ""), text=m.get("text", ""),
            attachments=[IntakeAttachment(filename=a["filename"], mime=a.get("mime") or "application/octet-stream", data=a.get("data"), sidecar_text=a.get("sidecar_text"))
                         for a in m.get("attachments", []) if a.get("data")][:10],
        )
        try:
            results.append(await intake(tenant_id, item, actor="gmail-sync", enqueue=enqueue))
        except Exception as e:  # noqa: BLE001
            # never lose a mail: the cursor already moved past it, so remember it and fetch it again next poll
            log.exception("sync.gmail_intake_failed", message_id=m["id"])
            failed.append(m["id"])
            results.append({"status": "error", "source_id": m["id"], "error": str(e)[:200]})
    if failed:
        async with session_scope() as s:
            conn = await get_connector(s, tenant_id, "gmail")
            cur = dict(conn.cursor or {})
            cur["retry"] = list(dict.fromkeys((cur.get("retry") or []) + failed))[-20:]
            conn.cursor = cur
    return {"status": "ok", "fetched": len(msgs), "results": results}


async def sync_all_gmail() -> None:
    async with session_scope() as s:
        tenants = (await s.execute(select(Connector.tenant_id).where(Connector.name == "gmail", Connector.status == "connected"))).scalars().all()
    for t in tenants:
        try:
            await sync_gmail(t)
        except Exception:  # noqa: BLE001
            log.exception("sync.gmail_failed", tenant_id=t)


async def default_tenant_id() -> str:
    from .config import get_settings

    async with session_scope() as s:
        slug = getattr(get_settings(), "default_tenant_slug", "demo")
        t = (await s.execute(select(Tenant).where(Tenant.slug == slug))).scalar_one_or_none()
        if t is None:
            t = (await s.execute(select(Tenant).order_by(Tenant.created_at).limit(1))).scalar_one()
        return t.id


async def handle_wa_event(tenant_id: str, ev: dict[str, Any], enqueue: bool = True) -> dict[str, Any]:
    typ = ev.get("type")
    if typ == "qr":
        await emit(tenant_id, "wa.qr", qr=ev.get("qr"))
        return {"ok": True}
    if typ == "connection":
        state = ev.get("state") or ev.get("status") or "disconnected"
        async with session_scope() as s:
            conn = await get_connector(s, tenant_id, "whatsapp")
            if conn.mode == "live":
                conn.status = "connected" if state == "open" else ("disconnected" if state in ("close", "closed", "disconnected", "logged_out") else conn.status)
                if state == "open" and not conn.authorized_at:
                    conn.authorized_at = utcnow()
                    conn.authorized_by = "whatsapp-qr"
            await append_audit(s, tenant_id, "connector.whatsapp", "wa-bridge", {"state": state})
        await emit(tenant_id, "connector.updated", name="whatsapp", status=state)
        return {"ok": True}
    if typ in ("message_edit", "message_delete"):
        from .lifecycle import handle

        return await handle(tenant_id, ev)  # CONTRACT_V3 §2
    if typ != "message":
        return {"ok": False, "error": "unknown event type"}
    msg = ev.get("message") or {}
    if not msg.get("id") or not msg.get("chat_id"):
        return {"ok": False, "error": "message.id and message.chat_id required"}
    media = msg.get("media") or None
    ts = msg.get("ts")
    if isinstance(ts, (int, float)):
        ts = datetime.fromtimestamp(ts / (1000 if ts > 1e12 else 1), tz=timezone.utc)
    elif isinstance(ts, str):
        try:
            ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            ts = None
    ts = ts or utcnow()
    async with session_scope() as s:
        exists = (await s.execute(select(WaMessage.id).where(WaMessage.tenant_id == tenant_id, WaMessage.message_id == msg["id"]))).first()
        if not exists:
            s.add(WaMessage(tenant_id=tenant_id, message_id=msg["id"], chat_id=msg["chat_id"], from_jid=msg.get("from", ""), from_name=msg.get("from_name", ""),
                            ts=ts, text=msg.get("text"), media_mime=(media or {}).get("mime")))
    atts = []
    if media and media.get("base64"):
        atts.append(IntakeAttachment(filename=media.get("filename") or "media", mime=media.get("mime") or "application/octet-stream", data_b64=media["base64"],
                                     sidecar_text=media.get("sidecar_text"), sha256=media.get("sha256")))
    item = IntakeItem(source="whatsapp", source_id=msg["id"], ts=ts, sender=msg.get("from", ""), sender_name=msg.get("from_name", ""), chat_id=msg["chat_id"],
                      text=msg.get("text") or "", attachments=atts, forwarded=bool(msg.get("forwarded")), quoted_id=msg.get("quoted_id") or None)
    res = await intake(tenant_id, item, actor="wa-bridge", enqueue=enqueue)
    try:
        await _team_receipts(tenant_id, msg, bool(atts), res)
    except Exception:  # noqa: BLE001  (receipts are best-effort; never affect intake)
        log.exception("sync.receipt_failed")
    # store derived text (OCR / transcript) for whatsapp_search
    if res.get("node_ids"):
        from .models import EvidenceNode

        async with session_scope() as s:
            node = await s.get(EvidenceNode, res["node_ids"][0])
            row = (await s.execute(select(WaMessage).where(WaMessage.tenant_id == tenant_id, WaMessage.message_id == msg["id"]))).scalar_one_or_none()
            if row and node:
                row.derived_text = node.derived_text
                row.media_object_key = node.media_object_key
    return res


async def _team_receipts(tenant_id: str, msg: dict[str, Any], has_media: bool, res: dict[str, Any]) -> None:
    """"Got it ✓ Added to PO-184 (Example Customer)" / "Which PO is this for?" to the watched team chat (internal
    messages, audited, can be turned off in Settings: receipts_enabled). A later PO answer links the waiting item."""
    from . import plain_language as pl
    from .models import Case
    from .notify import send_internal
    from .settings_service import get_tenant_settings

    async with session_scope() as s:
        st = await get_tenant_settings(s, tenant_id)
        case = await s.get(Case, res["case_id"]) if res.get("case_id") else None
        po, cust = (case.po_ref, case.customer) if case else (None, None)
    if not st.get("receipts_enabled", True):
        return
    lang = st.get("language", "en")
    chat = msg["chat_id"]
    if res.get("status") == "accepted" and case is not None and not has_media and (res.get("fields") or {}).get("po_ref"):
        from .unlinked import answer_which_po

        if await answer_which_po(tenant_id, chat, case.id):
            await send_internal(tenant_id, chat, pl.text(pl.RECEIPT, lang, po=po, customer=cust or "-"), kind="receipt")
        return
    if not has_media:
        if res.get("status") == "unlinked" and res.get("link") in ("ambiguous", "new_challan_no_po") and (res.get("fields") or {}).get("qty_delivered") is not None:
            # "40 more delivered" in a chat that talks about several open POs: ask instead of guessing
            await send_internal(tenant_id, chat, pl.text(pl.WHICH_PO, lang), kind="which_po")
        return
    if res.get("status") == "accepted" and case is not None:
        await send_internal(tenant_id, chat, pl.text(pl.RECEIPT, lang, po=po, customer=cust or "-"), kind="receipt")
    elif res.get("status") == "unlinked":
        await send_internal(tenant_id, chat, pl.text(pl.WHICH_PO, lang), kind="which_po")
