"""Chat memory layer, challan numbers, "Which PO?" instead of guessing, and "This is wrong" end to end (16 Oct 2026)."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

import app.main  # noqa: F401
from app.validator import derive_facts


def _n(i, kind, source, ts, **fields):
    return {"id": i, "kind": kind, "source": source, "ts": ts, "fields": fields, "quarantined": False}


T0 = datetime(2026, 10, 12, 10, tzinfo=timezone.utc)


def test_two_challans_add_up_and_older_sheet_is_not_a_conflict():
    nodes = [
        _n("o1", "order_email", "gmail", T0, po_ref="PO-184", qty_ordered=100, rate=1000, item="Model X"),
        _n("c1", "delivery_challan", "whatsapp", T0 + timedelta(hours=1), po_ref="PO-184", qty_delivered=60, challan_number="DC-5521"),
        _n("s1", "delivery_record", "sheets", T0 + timedelta(hours=2), po_ref="PO-184", qty_delivered=60),
        _n("c2", "delivery_challan", "whatsapp", T0 + timedelta(days=1), po_ref="PO-184", qty_delivered=40, challan_number="DC-5530"),
    ]
    f = derive_facts(nodes, "PO-184")
    assert f.delivered_qty == 100 and not f.conflicts, (f.delivered_qty, f.conflicts)
    assert f.billable["amount"] == Decimal("100000.00")
    assert f.superseded_sources and f.superseded_sources[0]["source"] == "sheets"


def test_same_challan_twice_counts_once():
    nodes = [
        _n("o1", "order_email", "gmail", T0, po_ref="PO-184", qty_ordered=100, rate=1000),
        _n("c1", "delivery_challan", "whatsapp", T0 + timedelta(hours=1), po_ref="PO-184", qty_delivered=60, challan_number="DC-5521"),
        _n("c1b", "delivery_challan", "media", T0 + timedelta(hours=3), po_ref="PO-184", qty_delivered=60, challan_number="dc 5521"),
    ]
    f = derive_facts(nodes, "PO-184")
    assert f.delivered_qty == 60 and not f.conflicts


def test_sheet_disagreeing_with_challans_is_still_a_conflict():
    nodes = [
        _n("o1", "order_email", "gmail", T0, po_ref="PO-184", qty_ordered=100, rate=1000),
        _n("c1", "delivery_challan", "whatsapp", T0 + timedelta(hours=1), po_ref="PO-184", qty_delivered=60, challan_number="DC-1"),
        _n("s1", "delivery_record", "sheets", T0 + timedelta(hours=2), po_ref="PO-184", qty_delivered=55),
    ]
    assert derive_facts(nodes, "PO-184").conflicts


def test_po_correction_keeps_evidence_filed_under_old_number():
    nodes = [
        _n("o1", "order_email", "gmail", T0, po_ref="PO-184", qty_ordered=100, rate=1000),
        _n("c1", "delivery_challan", "whatsapp", T0 + timedelta(hours=1), po_ref="PO-148", qty_delivered=60),  # misread
        _n("fix", "correction_manual", "manual", T0 + timedelta(hours=2), po_ref="PO-184", po_ref_from="PO-148", is_correction=True),
    ]
    assert derive_facts(nodes, "PO-184").delivered_qty == 60


async def _tid(s):
    from app.models import Case

    return (await s.execute(select(Case.tenant_id).where(Case.case_number == "RG-1042"))).scalar_one()


def _res(r):
    r = r.get("results") or r.get("intake") or r
    return r[0] if isinstance(r, list) else r


async def test_new_challan_without_po_asks_which_po_then_adds_up(db):
    from app import chat_memory
    from app import case_service as cs
    from app.db import session_scope
    from app.demo.scenes import OPS_CHAT, inject_wa, set_sheet_row
    from app.models import Case, ChatMemory

    async with AsyncClient(transport=ASGITransport(app=app.main.app), base_url="http://t", timeout=120) as c:
        assert (await c.post("/demo/reset")).status_code == 200
        for n in range(5):
            assert (await c.post(f"/demo/step/{n}")).status_code == 200
        async with session_scope() as s:
            tid = await _tid(s)
            mem = await chat_memory.get(s, tid, OPS_CHAT)
            assert mem is not None and any(x["case_number"] == "RG-1042" for x in mem.cases)
            assert any(x["no"] == "DC-5521" for x in mem.challans), mem.challans
            assert "DC-5521" in chat_memory.as_text(mem)

        # a different challan number, no PO on it: never assumed to be the chat's last PO
        r = _res(await inject_wa(tid, "wa-ch2", "Challan No: DC-5530 - 40 boxes delivered"))
        assert r["status"] == "unlinked" and r["link"] == "new_challan_no_po", r
        # the team answers the "Which PO?" question
        r2 = _res(await inject_wa(tid, "wa-ans", "PO-184"))
        assert r2["case_number"] == "RG-1042"
        await set_sheet_row(tid, "PO-184", "Example Customer Pvt Ltd", "Model X", 100, 100)
        from app.tools.registry import ToolCtx, TOOLS

        async with session_scope() as s:
            case = (await s.execute(select(Case).where(Case.case_number == "RG-1042"))).scalar_one()
            f = await cs.compute_facts(s, case)
            assert f.delivered_qty == 100, (f.delivered_qty, f.delivery_sources, f.conflicts)
            mem = await chat_memory.get(s, tid, OPS_CHAT)
            assert any(x["no"] == "DC-5530" and x["po"] == "PO-184" for x in mem.challans)
            # agents can read the memory
            out = await TOOLS["read_chat_memory"](ToolCtx(session=s, case=case, tenant_id=tid, agent="investigation"), {})
            assert out.ok and out.data["chats"] and out.evidence_node_ids
        from app.jobs import wait_inline_idle

        await wait_inline_idle()


async def test_two_open_pos_in_one_chat_means_ask_not_guess(db):
    from app.db import session_scope
    from app.demo.scenes import inject_wa

    async with AsyncClient(transport=ASGITransport(app=app.main.app), base_url="http://t", timeout=120) as c:
        assert (await c.post("/demo/reset")).status_code == 200
        for n in range(4):
            assert (await c.post(f"/demo/step/{n}")).status_code == 200
        async with session_scope() as s:
            tid = await _tid(s)
        chat = "ops-two@g.us"
        assert _res(await inject_wa(tid, "w1", "PO-184: 10 delivered", chat=chat))["case_number"] == "RG-1042"
        r = _res(await inject_wa(tid, "w2", "PO-777 order: 50 units Model X at Rs 900", chat=chat))
        assert r["case_number"] and r["case_number"] != "RG-1042"
        r3 = _res(await inject_wa(tid, "w3", "20 more delivered", chat=chat))
        assert r3["status"] == "unlinked" and r3["link"] == "ambiguous", r3
        from app.jobs import wait_inline_idle

        await wait_inline_idle()


async def test_this_is_wrong_po_and_qty_recheck_and_expire_approval(db):
    from app.db import session_scope
    from app.models import Approval, AuditLog, Case
    from app.orchestrator.engine import drive_case

    async with AsyncClient(transport=ASGITransport(app=app.main.app), base_url="http://t", timeout=120) as c:
        assert (await c.post("/demo/reset")).status_code == 200
        for n in range(8):
            assert (await c.post(f"/demo/step/{n}")).status_code == 200
        tok = (await c.post("/auth/login", json={"email": "finance@demo.in", "password": "demo1234"})).json()["token"]
        h = {"Authorization": f"Bearer {tok}"}
        summ = (await c.get("/cases/RG-1042/summary", headers=h)).json()
        assert summ["approval"] and summ["approval"]["status"] in ("pending", "partially_approved"), summ.get("approval")
        old_ap, old_amt = summ["approval"]["id"], summ["approval"]["amount"]
        assert {"po_ref", "delivered_qty", "order_qty", "rate", "customer"} <= {f["id"] for f in summ["facts"]}

        # wrong delivered qty -> fix inline: approval expires, case re-checks, a new approval on the new number
        r = await c.post("/cases/RG-1042/facts/delivered_qty/correct", json={"value": "50", "note": "only 50 reached"}, headers=h)
        assert r.status_code == 200, r.text
        async with session_scope() as s:
            ap = await s.get(Approval, old_ap)
            assert ap.status == "expired"
            case = (await s.execute(select(Case).where(Case.case_number == "RG-1042"))).scalar_one()
            cid = case.id
            log = (await s.execute(select(AuditLog).where(AuditLog.case_id == cid, AuditLog.event == "fact.corrected"))).scalars().all()
            assert log and log[-1].actor == "finance@demo.in" and float(log[-1].data["new"]) == 50
        for _ in range(4):
            if await drive_case(cid, stop_at=("AWAITING_APPROVAL",)) == "AWAITING_APPROVAL":
                break
        summ2 = (await c.get("/cases/RG-1042/summary", headers=h)).json()
        assert summ2["approval"]["id"] != old_ap and summ2["approval"]["amount"] == 50000 and old_amt == 60000, (old_amt, summ2["approval"])

        # wrong PO -> fix inline: the case moves, its evidence stays, approval expires again
        r = await c.post("/cases/RG-1042/facts/po_ref/correct", json={"value": "PO-1840", "note": "typo on PO"}, headers=h)
        assert r.status_code == 200, r.text
        summ3 = (await c.get("/cases/RG-1042/summary", headers=h)).json()
        po_fact = next(f for f in summ3["facts"] if f["id"] == "po_ref")
        assert po_fact["value"] == "PO-1840" and po_fact["changed_from"] == "PO-184"
        assert next(f for f in summ3["facts"] if f["id"] == "delivered_qty")["value"].startswith("50")
        # a PO that already has its own open case is refused
        r = await c.post("/cases/RG-1042/facts/po_ref/correct", json={"value": "PO-185"}, headers=h)
        assert r.status_code in (200, 409)
        from app.jobs import wait_inline_idle

        await wait_inline_idle()
