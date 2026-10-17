"""LLM reads and interprets messages with the case in view; code only checks its numbers (no static rules in real mode)."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from httpx import ASGITransport, AsyncClient

import app.main  # noqa: F401
from app.extraction import extract_fields, ground
from app.validator import derive_facts


def test_ground_drops_numbers_not_in_message():
    f = ground({"qty_delivered": 100, "rate": 1000, "confidence": 0.9}, "Correction: 100, not 60")
    assert f["qty_delivered"] == 100 and f["rate"] is None and f["_ungrounded"] == ["rate"] and f["confidence"] <= 0.5
    assert ground({"qty_delivered": 40}, "nalabhai vachayi")["qty_delivered"] == 40  # Telugu number word


def _fake(reader):
    """Replace the model for extract_fields only; reader(text, user_msg) -> dict."""
    from app.llm import router as r

    real = r.get_llm().complete_structured

    async def fake(task, messages, schema, mock_fn, **kw):
        if task != "extract_fields":
            return await real(task, messages, schema, mock_fn, **kw)
        user = messages[-1]["content"]
        return r.LLMResult(data=reader(user), provider="nim", model="deepseek-ai/deepseek-v4.1-flash", latency_ms=5, cost_inr=0, tokens=10, attempts=[], mock=False)

    return fake


async def test_reader_gets_case_context_and_is_grounded(monkeypatch):
    from app.llm import router as r

    seen = {}

    def reader(user):
        seen["user"] = user
        return {"doc_type": "correction", "qty_delivered": 100, "is_correction": True, "confidence": 0.95, "rate": 999, "meaning": "total is 100"}

    monkeypatch.setattr(r.get_llm(), "complete_structured", _fake(reader))
    f, meta = await extract_fields("Correction:100,not 60", source="whatsapp", source_id="x", context="Case RG-1 for PO-184. Delivered so far: 60")
    assert "CURRENT CASE" in seen["user"] and "PO-184" in seen["user"]
    assert f["qty_delivered"] == 100 and f["is_correction"] and f["rate"] is None and f["read_by"].startswith("nim:")


async def test_no_model_in_real_mode_means_unread_not_regex(monkeypatch):
    from app.config import get_settings
    from app.llm import router as r

    async def down(*a, **k):
        raise r.LLMUnavailable("all down")

    monkeypatch.setattr(r.get_llm(), "complete_structured", down)
    monkeypatch.setattr(get_settings(), "demo_mode", False)
    f, meta = await extract_fields("40 more delivered", source="whatsapp", source_id="x")
    assert f == {"pending_read": True, "doc_type": "other"} and meta["pending"]


def _n(i, kind, source, ts, **fields):
    return {"id": i, "kind": kind, "source": source, "ts": ts, "fields": fields, "quarantined": False}


def test_unsure_reading_asks_a_person_until_corrected():
    t0 = datetime(2026, 10, 12, 10, tzinfo=timezone.utc)
    nodes = [
        _n("o1", "order_email", "gmail", t0, po_ref="PO-184", qty_ordered=100, rate=1000),
        _n("c1", "delivery_challan", "media", t0 + timedelta(hours=1), po_ref="PO-184", qty_delivered=60),
        _n("m1", "whatsapp_message", "whatsapp", t0 + timedelta(hours=2), po_ref="PO-184", qty_delivered=40, confidence=0.5, meaning="40 more or 40 total?"),
    ]
    f = derive_facts(nodes, "PO-184")
    assert f.delivered_qty == 60 and f.conflicts and f.conflicts[0]["reason"] == "40 more or 40 total?"
    nodes.append(_n("fix", "correction_message", "manual", t0 + timedelta(hours=3), po_ref="PO-184", qty_delivered=100, is_correction=True))
    f2 = derive_facts(nodes, "PO-184")
    assert f2.delivered_qty == 100 and not f2.conflicts and f2.billable["amount"] == Decimal("100000.00")


async def test_whatsapp_correction_read_by_llm_updates_the_case(db, monkeypatch):
    """Sai's case: challan says 60, then 'Correction:100,not 60' on WhatsApp -> delivered 100 (the LLM reads it, not a pattern)."""
    from sqlalchemy import select

    from app.db import session_scope
    from app.demo.scenes import inject_wa
    from app.llm import router as r
    from app.models import Case
    from app import case_service as cs

    def reader(user):
        if "Correction:100,not 60" in user:
            assert "CURRENT CASE" in user
            return {"doc_type": "correction", "qty_delivered": 100, "is_correction": True, "confidence": 0.93, "meaning": "delivered total is 100, not 60"}
        return {"doc_type": "other"}

    async with AsyncClient(transport=ASGITransport(app=app.main.app), base_url="http://t", timeout=120) as c:
        assert (await c.post("/demo/reset")).status_code == 200
        for n in range(5):
            assert (await c.post(f"/demo/step/{n}")).status_code == 200
        async with session_scope() as s:
            case = (await s.execute(select(Case).where(Case.case_number == "RG-1042"))).scalar_one()
            tid, before = case.tenant_id, (await cs.compute_facts(s, case)).delivered_qty
        monkeypatch.setattr(r.get_llm(), "complete_structured", _fake(reader))
        res = await inject_wa(tid, "wa-corr-100", "Correction:100,not 60")
        res = (res.get("results") or [res])[0] if isinstance(res, dict) else res
        assert res["status"] == "accepted" and res["case_number"] == "RG-1042", res
        async with session_scope() as s:
            case = (await s.execute(select(Case).where(Case.case_number == "RG-1042"))).scalar_one()
            assert before == 60 and (await cs.compute_facts(s, case)).delivered_qty == 100
