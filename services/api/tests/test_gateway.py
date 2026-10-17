import asyncio

from app.db import session_scope
from app.flags import KILL_SWITCH, set_flag
from app.gateway import execute, idempotency_key, required_approvers
from app.models import Approval, Proposal

from .helpers import actions, case_by_ref, latest_approval, play, suppress, user, zoho_invoices


async def _approved(tid):
    from app.approvals import approve

    await play(7)  # PO-184 through AWAITING_APPROVAL (₹60,000)
    case = await case_by_ref("PO-184")
    ap = await latest_approval(case.id)
    assert ap.status == "pending" and float(ap.amount) == 60000.0
    async with suppress():
        out = await approve(ap.id, await user("finance@demo.in"), "ok")
    assert out["status"] == "approved"
    return case, ap


def test_required_approvers_threshold():
    assert required_approvers(100000) == 1 and required_approvers(100000.01) == 2 and required_approvers(70000) == 1


async def test_concurrent_and_repeated_execution_writes_once(db):
    case, ap = await _approved(db)
    r1, r2 = await asyncio.gather(execute(ap.id, "t1"), execute(ap.id, "t2"))
    assert sorted([r1.status, r2.status]) == ["duplicate", "succeeded"]
    r3 = await execute(ap.id, "t3")
    assert r3.status == "duplicate"
    invs = await zoho_invoices(db, "PO-184")
    assert len(invs) == 1 and invs[0]["total"] == 70800.0 and invs[0]["sub_total"] == 60000.0  # ₹60,000 + 18% GST (UX v2)
    acts = await actions(case.id)
    assert len(acts) == 1 and acts[0].status == "succeeded"
    async with session_scope() as s:
        prop = await s.get(Proposal, ap.proposal_id)
    assert acts[0].idempotency_key == idempotency_key(db, case.id, prop.id, ap.payload_hash)


async def test_timeout_then_retry_after_read_adopts_existing(db):
    case, ap = await _approved(db)
    async with session_scope() as s:
        await set_flag(s, db, "chaos:zoho_timeout_once", True)
    r = await execute(ap.id, "t")
    assert r.status == "succeeded"
    r2 = await execute(ap.id, "t")
    assert r2.status == "duplicate"
    assert len(await zoho_invoices(db, "PO-184")) == 1


async def test_zoho_down_then_retry_same_key(db):
    case, ap = await _approved(db)
    async with session_scope() as s:
        await set_flag(s, db, "chaos:zoho_down", True)
    r = await execute(ap.id, "t")
    assert r.status == "paused" and r.detail["connector"] == "zoho"
    async with session_scope() as s:
        await set_flag(s, db, "chaos:zoho_down", False)
    r2 = await execute(ap.id, "t")
    assert r2.status == "succeeded" and r2.action_id == r.action_id  # same idempotency key, same action row
    assert len(await zoho_invoices(db, "PO-184")) == 1


async def test_kill_switch_blocks_all_writes(db):
    case, ap = await _approved(db)
    async with session_scope() as s:
        await set_flag(s, db, KILL_SWITCH, True)
    r = await execute(ap.id, "t")
    assert r.status == "paused" and r.detail["reason"] == "kill_switch"
    assert await zoho_invoices(db, "PO-184") == []


async def test_tampered_payload_blocked(db):
    case, ap = await _approved(db)
    async with session_scope() as s:
        p = await s.get(Proposal, ap.proposal_id)
        p.payload = {**p.payload, "amount": 65000.0}
    r = await execute(ap.id, "t")
    assert r.status == "blocked" and r.detail["reason"] == "payload_hash_mismatch"
    assert await zoho_invoices(db, "PO-184") == []


async def test_amount_above_1L_needs_two_distinct_approvers(db):
    case, ap = await _approved(db)
    async with session_scope() as s:
        p = await s.get(Proposal, ap.proposal_id)
        p.payload = {**p.payload, "amount": 150000.0}
    r = await execute(ap.id, "t")
    assert r.status == "blocked" and "approvers" in r.detail["reason"]


async def test_existing_invoice_precheck_blocks_duplicate(db):
    from app.connectors.registry import adapter

    case, ap = await _approved(db)
    async with session_scope() as s:
        z = await adapter(s, db, "zoho")
        await z.create_invoice({"customer_id": "zc-1001", "reference_number": "PO 184", "line_items": [{"name": "Model X", "quantity": 60, "rate": 1000}]}, "someone-else")
    r = await execute(ap.id, "t")
    assert r.status == "blocked" and r.detail["reason"] == "existing_invoice"
    assert len(await zoho_invoices(db, "PO-184")) == 1


async def test_operator_cannot_approve(db):
    from app.approvals import ApprovalError, approve

    await play(7)  # PO-184 through AWAITING_APPROVAL (₹60,000)
    case = await case_by_ref()
    ap = await latest_approval(case.id)
    try:
        await approve(ap.id, await user("ops@demo.in"))
        raise AssertionError("operator approval must fail")
    except ApprovalError as e:
        assert e.status == 403
    ap2 = await latest_approval(case.id)
    assert ap2.status == "pending" and ap2.approvers == []


async def test_wa_bridge_409_only_counts_as_sent_when_bridge_says_sent(monkeypatch):
    """wa-bridge keeps idempotency keys burned after partial failures: a 409 is "already sent" ONLY for status=sent."""
    import httpx
    import pytest

    from app.connectors.base import ConnectorError
    from app.connectors.whatsapp import BridgeWhatsApp

    replies: dict[str, httpx.Response] = {}
    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(lambda req: replies[req.url.path]), **kw))
    wa = BridgeWhatsApp(None, None, "t")

    replies["/send"] = httpx.Response(409, json={"ok": False, "error": "duplicate_idempotency_key", "status": "sent", "message_id": "WA-1"})
    assert await wa.send("+919800000002", "hi", "key-12345678", "ap-1") == "WA-1"
    for st in ("failed", "pending"):
        replies["/send"] = httpx.Response(409, json={"ok": False, "error": "duplicate_idempotency_key", "status": st, "message_id": None})
        with pytest.raises(ConnectorError) as ei:
            await wa.send("+919800000002", "hi", "key-12345678", "ap-1")
        assert ei.value.retryable is False and "outcome unknown" in str(ei.value)

    replies["/idempotency/lookup"] = httpx.Response(404, json={"ok": True, "found": False})
    assert await wa.lookup_send("key-12345678") is None
    replies["/idempotency/lookup"] = httpx.Response(200, json={"ok": True, "found": True, "status": "sent", "message_id": "WA-1"})
    assert (await wa.lookup_send("key-12345678"))["message_id"] == "WA-1"
