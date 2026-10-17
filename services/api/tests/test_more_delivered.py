"""'40 more delivered' after a challan: incremental deliveries are added, never silently dropped (bug reported 16 Oct 2026)."""
import asyncio
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from httpx import ASGITransport, AsyncClient

import app.main  # noqa: F401  (registers every model before the db fixture creates tables)
from app.extraction import regex_extract
from app.validator import derive_facts


def test_regex_incremental_phrases():
    for t in ("40 more delivered", "40 more boxes delivered today", "aur 40 gaye", "another 40 units dispatched",
              "PO-184: 40 more have been delivered", "40 extra sent", "delivered another 40"):
        f = regex_extract(t)
        assert f.get("qty_delivered") == 40 and f.get("is_incremental") is True and f["doc_type"] == "delivery", (t, f)
    f = regex_extract("60 boxes delivered, 40 pending")
    assert f["qty_delivered"] == 60 and not f.get("is_incremental")


def _n(i, kind, source, ts, **fields):
    return {"id": i, "kind": kind, "source": source, "ts": ts, "fields": fields, "quarantined": False}


def test_validator_adds_increments_to_latest_full_count():
    t0 = datetime(2026, 10, 12, 10, tzinfo=timezone.utc)
    nodes = [
        _n("o1", "order_email", "gmail", t0, po_ref="PO-184", qty_ordered=100, rate=1000, item="Model X"),
        _n("c1", "delivery_challan", "media", t0 + timedelta(hours=1), po_ref="PO-184", qty_delivered=60),
        _n("m1", "whatsapp_message", "whatsapp", t0 + timedelta(hours=2), po_ref="PO-184", qty_delivered=40, is_incremental=True),
    ]
    f = derive_facts(nodes, "PO-184")
    assert f.delivered_qty == 100 and not f.conflicts and f.billable["amount"] == Decimal("100000.00")
    # a later full count replaces everything before it (increment before it is already inside the count)
    nodes.append(_n("s1", "delivery_record", "sheets", t0 + timedelta(hours=3), po_ref="PO-184", qty_delivered=100))
    f2 = derive_facts(nodes, "PO-184")
    assert f2.delivered_qty == 100


async def test_more_delivered_after_case_closed_opens_follow_up(db):
    from app.demo.scenes import OPS_CHAT, inject_wa
    from app.main import app
    from app.db import session_scope
    from app.models import Case
    from sqlalchemy import select

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t", timeout=120) as c:
        assert (await c.post("/demo/reset")).status_code == 200
        for n in range(12):
            assert (await c.post(f"/demo/step/{n}")).status_code == 200
        async with session_scope() as s:
            tid = (await s.execute(select(Case.tenant_id).where(Case.case_number == "RG-1042"))).scalar_one()
            assert (await s.execute(select(Case.state).where(Case.case_number == "RG-1042"))).scalar_one() == "CLOSED"
        r = await inject_wa(tid, "wa-more-1", "30 more delivered")
        res = r.get("intake") or r
        res = res[0] if isinstance(res, list) else res
        assert res["status"] == "accepted" and res["link"] == "follow_up" and res["case_number"] != "RG-1042", res
        new_ref = res["case_number"]
        from app.orchestrator.engine import drive_case

        async with session_scope() as s:
            new_id = (await s.execute(select(Case.id).where(Case.case_number == new_ref))).scalar_one()
        st = None
        for _ in range(4):  # the case may park in WATCHING once while evidence settles
            st = await drive_case(new_id, stop_at=("AWAITING_APPROVAL",))
            if st == "AWAITING_APPROVAL":
                break
        async with session_scope() as s:
            st = (await s.execute(select(Case.state).where(Case.id == new_id))).scalar_one()
        assert st == "AWAITING_APPROVAL", st
        tok = (await c.post("/auth/login", json={"email": "finance@demo.in", "password": "demo1234"})).json()["token"]
        summ = (await c.get(f"/cases/{new_ref}/summary", headers={"Authorization": f"Bearer {tok}"})).json()
        assert summ["po_ref"] == "PO-184"
        assert summ["approval"]["amount"] == 30000, summ["approval"]
        # approve the top-up and let it run: a second invoice for the same PO, only for the extra 30 units
        ap_id = summ["approval"]["id"]
        r = await c.post(f"/approvals/{ap_id}/approve", headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200, r.text
        await drive_case(new_id)
        async with session_scope() as s:
            st = (await s.execute(select(Case.state).where(Case.id == new_id))).scalar_one()
        from .helpers import zoho_invoices

        invs = sorted((i["invoice_number"], float(i["total"])) for i in await zoho_invoices(tid, "PO-184"))
        assert st == "CLOSED", st
        assert invs == [("INV-2301", 82600.0), ("INV-2302", 35400.0)], invs


def test_regex_filler_words():
    for t in ("40 got delivered", "40 boxes have been delivered", "40 were delivered today"):
        f = regex_extract(t)
        assert f.get("qty_delivered") == 40 and not f.get("is_incremental"), (t, f)


async def test_voice_note_without_transcript_is_not_suspicious(db, monkeypatch):
    import base64

    from app.intake import IntakeItem, intake
    from app.llm import router as r

    async def fail(*a, **k):
        raise r.LLMUnavailable("no stt key")

    monkeypatch.setattr(r.get_llm(), "transcribe", fail)
    res = await intake(db, IntakeItem(source="whatsapp", source_id="wa-voice-1", sender_name="Uma", chat_id="919900@s.whatsapp.net",
                                      attachments=[{"filename": "voice.ogg", "mime": "audio/ogg", "data_b64": base64.b64encode(b"OggS-fake-audio").decode()}]), enqueue=False)
    assert res["status"] != "quarantined" and res["unread_audio"] == ["voice.ogg"], res
