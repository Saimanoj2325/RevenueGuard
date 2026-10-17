"""Timeline agent: the code verifier, and the wiring with a scripted fake model (live mode: the agent's verified
decision drives the delivered total; a failed check -> Needs a check; no model -> pending, never regex)."""
from __future__ import annotations

import copy

import pytest
from sqlalchemy import select

import app.main  # noqa: F401
from app.timeline_verify import verify

from .helpers import case_by_ref, suppress
from .timeline_fakes import install, smart

T = "tenant-1"
NODES = {
    "a": {"id": "a", "tenant_id": T, "excerpt": "CH-101: 60 delivered", "fields": {"qty_delivered": 60}},
    "b": {"id": "b", "tenant_id": T, "excerpt": "CH-102 forty boxes sent", "fields": {}},
    "c": {"id": "c", "tenant_id": T, "excerpt": "CH-101: 60 delivered", "fields": {"status": "duplicate", "duplicate_of": "a"}},
    "d": {"id": "d", "tenant_id": T, "excerpt": "90 delivered", "fields": {"status": "deleted"}},
}
CASES = {"RG-1": {"case_number": "RG-1", "po_ref": "PO-184"}}


def good() -> dict:
    return {"link": {"action": "existing_case", "case_ref": "RG-1", "po_ref": "PO-184", "why": "same PO"}, "meaning": "delivery",
            "delivered": {"total": 100, "events": [{"node_id": "a", "qty": 60, "role": "counts", "why": "challan 101"},
                                                   {"node_id": "b", "qty": 40, "role": "counts", "why": "challan 102"},
                                                   {"node_id": "c", "qty": 60, "role": "duplicate_of:a", "why": "same photo"}]},
            "memory_patch": {}, "confidence": 0.9, "explanation_for_owner": "Two challans: 60 + 40 = 100 delivered."}


def test_verifier_accepts_a_good_decision():
    assert verify(good(), NODES, tenant_id=T, cases=CASES) == (True, [])


def test_verifier_rejects_ungrounded_qty():
    d = good()
    d["delivered"]["events"][1]["qty"] = 45
    d["delivered"]["total"] = 105
    ok, failed = verify(d, NODES, tenant_id=T, cases=CASES)
    assert not ok and any("45 from" in x and "not in the message" in x for x in failed)


def test_verifier_rejects_wrong_sum():
    d = good()
    d["delivered"]["total"] = 160
    ok, failed = verify(d, NODES, tenant_id=T, cases=CASES)
    assert not ok and any("does not match" in x for x in failed)


@pytest.mark.parametrize("nid,word", [("c", "sent again"), ("d", "deleted")])
def test_verifier_rejects_counting_a_duplicate_or_deleted_message(nid, word):
    d = good()
    d["delivered"]["events"] = [e for e in d["delivered"]["events"] if e["node_id"] != "c"]
    d["delivered"]["events"].append({"node_id": nid, "qty": NODES[nid]["fields"].get("qty_delivered") or (60 if nid == "c" else 90), "role": "counts", "why": "x"})
    d["delivered"]["total"] = sum(e["qty"] for e in d["delivered"]["events"] if e["role"] == "counts")
    ok, failed = verify(d, NODES, tenant_id=T, cases=CASES)
    assert not ok and any(word in x for x in failed)


def test_verifier_rejects_low_confidence_unknown_node_other_tenant_and_ungrounded_new_po():
    d = good()
    d["confidence"] = 0.6
    assert any("not sure" in x for x in verify(d, NODES, tenant_id=T, cases=CASES)[1])
    d = good()
    d["delivered"]["events"][0]["node_id"] = "zzz"
    assert any("do not have" in x for x in verify(d, NODES, tenant_id=T, cases=CASES)[1])
    other = copy.deepcopy(NODES)
    other["a"]["tenant_id"] = "someone-else"
    assert not verify(good(), other, tenant_id=T, cases=CASES)[0]
    d = good()
    d["link"] = {"action": "new_case", "case_ref": None, "po_ref": "PO-999", "why": "new order"}
    assert any("not in the message" in x for x in verify(d, NODES, tenant_id=T, cases={}, trigger_text="40 delivered")[1])
    assert verify(d, NODES, tenant_id=T, cases={}, trigger_text="PO 999: 40 delivered")[0]


# ------------------------------------------------------------------ wiring with the fake model
CHAT = "1203630000000777@g.us"


async def order(tid: str, po: str = "PO-7101", qty: int = 100, rate: int = 1000) -> dict:
    from app.intake import IntakeItem, intake

    return await intake(tid, IntakeItem(source="gmail", source_id=f"po-{po}", sender="accounts@example-customer.in", subject=f"Purchase Order {po}",
                                        text=f"Purchase Order {po}\nCustomer: Example Customer Pvt Ltd\nItem: Model X\nQty: {qty}\nRate: Rs {rate}"), enqueue=False)


async def wa(tid: str, mid: str, text: str, chat: str = CHAT, **kw) -> dict:
    from app.demo.scenes import inject_wa

    return await inject_wa(tid, mid, text, chat=chat, **kw)


async def facts(po: str = "PO-7101"):
    from app import case_service as cs
    from app.db import session_scope
    from app.models import Case

    c = await case_by_ref(po)
    async with session_scope() as s:
        return await cs.compute_facts(s, await s.get(Case, c.id))


async def summary(po: str = "PO-7101") -> dict:
    from app.business import case_summary
    from app.db import session_scope
    from app.models import Case

    c = await case_by_ref(po)
    async with session_scope() as s:
        return await case_summary(s, await s.get(Case, c.id))


async def test_good_decision_drives_the_facts_and_shows_tool_calls(db, monkeypatch):
    from app.db import session_scope
    from app.models import AgentEvent

    seen = install(monkeypatch, smart)
    async with suppress():
        await order(db)
        r = await wa(db, "w1", "CH-1: 60 delivered for PO-7101")
        assert r["status"] == "accepted" and r["timeline"]["verified"], r
        assert (await facts()).delivered_qty == 60
    s = await summary()
    td = s["timeline_decision"]
    assert td["verified"] and td["delivered_total"] == 60 and td["meaning"] == "delivery" and td["source"] == "llm"
    assert any(x["role"] == "counts" and x["qty"] == 60 for x in s["timeline"])
    assert {"read_case_timeline", "read_chat_memory"} <= set(seen["tools"])
    case = await case_by_ref("PO-7101")
    async with session_scope() as ss:
        evs = (await ss.execute(select(AgentEvent).where(AgentEvent.case_id == case.id, AgentEvent.agent == "timeline"))).scalars().all()
    calls = [e.data for e in evs if e.type == "tool_call"]
    assert any(c["tool"] == "read_case_timeline" and c["args"].get("why") for c in calls)
    assert any(e.type == "step_finished" and (e.data.get("verifier") or {}).get("verified") for e in evs)


def _bad(change):
    def decider(trig, nodes, mem):
        d = smart(trig, nodes, mem)
        change(d, nodes)
        return d
    return decider


def _ungrounded(d, nodes):
    for e in d["delivered"]["events"]:
        if e["role"] == "counts":
            e["qty"] = 70
    d["delivered"]["total"] = sum(e["qty"] for e in d["delivered"]["events"] if e["role"] == "counts") or None


def _wrong_sum(d, nodes):
    if d["delivered"]["total"] is not None:
        d["delivered"]["total"] += 10


def _low(d, nodes):
    d["confidence"] = 0.55


@pytest.mark.parametrize("change,word", [(_ungrounded, "not in the message"), (_wrong_sum, "does not match"), (_low, "not sure")])
async def test_bad_decision_goes_to_needs_a_check(db, monkeypatch, change, word):
    install(monkeypatch, _bad(change))
    async with suppress():
        await order(db)
        r = await wa(db, "w1", "CH-1: 60 delivered for PO-7101")
        assert r["timeline"]["verified"] is False
        f = await facts()
    assert f.delivered_qty is None and not f.billable  # nothing billable on an unchecked reading
    c = next(c for c in f.conflicts if c.get("source") == "timeline_check")
    assert word in c["reason"]
    s = await summary()
    assert s["confidence"] == "needs_check" and s["confidence_reason"].startswith("Needs a check") and word in s["confidence_reason"]
    assert s["timeline_decision"]["verified"] is False and s["timeline_decision"]["failed_checks"]


async def test_counting_a_resent_photo_is_rejected(db, monkeypatch):
    from .test_message_lifecycle import png

    def count_everything(trig, nodes, mem):
        d = smart(trig, nodes, mem)
        for e in d["delivered"]["events"]:
            if e["role"].startswith("duplicate_of:"):
                e["role"] = "counts"
        d["delivered"]["total"] = sum(e["qty"] for e in d["delivered"]["events"] if e["role"] == "counts")
        return d

    install(monkeypatch, count_everything)
    img = png(1)
    async with suppress():
        await order(db)
        await wa(db, "p1", "CH-1 60 delivered PO-7101", media={"mime": "image/png", "filename": "challan.png", "base64": img})
        r = await wa(db, "p2", "CH-1 60 delivered PO-7101", media={"mime": "image/png", "filename": "challan.png", "base64": img})
    assert r["timeline"]["verified"] is False and any("sent again" in x for x in r["timeline"]["failed_checks"])


async def test_model_down_waits_as_pending_then_retries(db, monkeypatch):
    from app.timeline import retry_pending

    install(monkeypatch, smart, down=True)
    async with suppress():
        await order(db)
        r = await wa(db, "w1", "CH-1: 60 delivered for PO-7101")
        assert r["timeline"]["status"] == "pending"
        f = await facts()
        assert f.delivered_qty is None and not f.billable  # never falls back to static rules in live mode
        install(monkeypatch, smart)  # model is back
        assert await retry_pending() >= 1
        assert (await facts()).delivered_qty == 60


def test_tool_loop_json_protocol_fallback_parses_tool_calls_and_final():
    from app.llm.tool_loop import _from_json_protocol

    content, calls = _from_json_protocol('{"tool": "read_case_timeline", "args": {"why": "x"}}', 3)
    assert content == "" and calls[0].name == "read_case_timeline" and calls[0].args == {"why": "x"}
    content, calls = _from_json_protocol('{"final": {"meaning": "noise"}}', 4)
    assert calls == [] and '"noise"' in content
