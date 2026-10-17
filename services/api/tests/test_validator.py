from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.validator import (
    BillingRule, build_timeline, check_proposal, compute_billable, derive_facts, find_duplicates, normalize_ref, ref_variants, refs_match, text_mentions_ref,
)


@pytest.mark.parametrize("raw,norm", [("PO-184", "PO184"), ("po 184", "PO184"), ("P.O. #0184", "PO184"), ("PO/184", "PO184"), ("184", "184"), ("SO-00185", "SO185"), (None, None)])
def test_normalize_ref(raw, norm):
    assert normalize_ref(raw) == norm


def test_ref_variants_and_matching():
    v = ref_variants("PO-184")
    assert "PO-184" in v and "PO184" in v and "PO 184" in v and "184" in v and "PO-0184" in v
    assert all(normalize_ref(x).endswith("184") for x in v)
    assert refs_match("PO 184", "po-184") and refs_match("184", "PO-184") and not refs_match("PO-170", "PO-184")
    assert text_mentions_ref("please bill P.O. 184 today", "PO-184") and not text_mentions_ref("PO-1840 shipped", "PO-184")


def test_compute_billable_on_delivery_partial():
    r = compute_billable(100, 60, "1,000", "on_delivery")
    assert r["billable_qty"] == Decimal(60) and r["amount"] == Decimal("60000.00") and r["rate"] == Decimal("1000.00")


def test_compute_billable_caps_and_already_invoiced():
    r = compute_billable(100, 120, 1000, {"mode": "on_delivery"}, already_invoiced_qty=60)
    assert r["billable_qty"] == Decimal(40) and r["amount"] == Decimal("40000.00")
    assert any("exceeds ordered" in x for x in r["reasons"])


def test_compute_billable_full_delivery_rule_and_not_due():
    assert compute_billable(100, 70, 1000, "on_full_delivery")["amount"] == Decimal("0.00")
    delivered = datetime(2026, 10, 10, tzinfo=timezone.utc)
    r = compute_billable(100, 100, 1000, {"mode": "on_delivery", "delay_days": 7}, delivered_at=delivered, now=delivered + timedelta(days=2))
    assert r["not_due"] and r["amount"] == Decimal("0.00") and r["amount_when_due"] == Decimal("100000.00")
    r2 = compute_billable(100, 100, 1000, {"mode": "on_delivery", "delay_days": 7}, delivered_at=delivered, now=delivered + timedelta(days=8))
    assert not r2["not_due"] and r2["amount"] == Decimal("100000.00")


def test_compute_billable_decimal_exactness():
    r = compute_billable(3, 3, "333.335", "on_delivery")
    assert r["rate"] == Decimal("333.34") and r["amount"] == Decimal("1000.02")
    with pytest.raises(ValueError):
        compute_billable(-1, 0, 10)


def test_find_duplicates():
    invs = [
        {"invoice_id": "1", "invoice_number": "INV-1", "reference_number": "PO 184", "total": 70000},
        {"invoice_id": "2", "invoice_number": "INV-2", "reference_number": "PO-170", "total": 70000},
        {"invoice_id": "3", "invoice_number": "INV-3", "reference_number": "", "notes": "against P.O. 184", "total": 10},
        {"invoice_id": "4", "invoice_number": "INV-4", "reference_number": "PO184", "total": 5, "status": "void"},
    ]
    d = find_duplicates(invs, "PO-184", 70000)
    assert [x["invoice_number"] for x in d] == ["INV-1", "INV-3"] and d[0]["exact"] and not d[1]["exact"]


FACTS = {"evidence_node_ids": ["n1", "n2"], "quarantined_node_ids": ["q1"], "billable": {"billable_qty": 70, "rate": 1000, "amount": 70000},
         "duplicates": [], "customer_id": "zc-1001", "customer_name": "Example Customer Pvt Ltd", "reference": "PO-184", "item": "Model X"}


def test_check_proposal_overrides_agent_numbers():
    p = {"action": {"type": "create_invoice", "customer_id": "zc-1001", "reference": "PO-184", "amount": 100000, "line_items": [{"item": "Model X", "qty": 100, "rate": 1000}]},
         "claims": [{"text": "x", "evidence_node_ids": ["n1"]}]}
    r = check_proposal(p, FACTS)
    assert r["ok"]
    assert r["corrected_action"]["amount"] == 70000.0 and r["corrected_action"]["line_items"] == [{"item": "Model X", "qty": 70.0, "rate": 1000.0}]
    assert any("amount_overridden" in w for w in r["warnings"])


def test_check_proposal_rejects_bad_citations_and_duplicates():
    base = {"type": "create_invoice", "amount": 70000, "line_items": [{"item": "Model X", "qty": 70, "rate": 1000}]}
    assert "no_claims: a proposal must cite evidence" in check_proposal({"action": base, "claims": []}, FACTS)["errors"]
    r = check_proposal({"action": base, "claims": [{"text": "a", "evidence_node_ids": ["zzz"]}, {"text": "b", "evidence_node_ids": ["q1"]}, {"text": "c", "evidence_node_ids": []}]}, FACTS)
    assert not r["ok"] and len(r["errors"]) == 3 and any("quarantined" in e for e in r["errors"])
    dup = dict(FACTS, duplicates=[{"invoice_number": "INV-1"}])
    assert "duplicate_invoice_exists" in check_proposal({"action": base, "claims": [{"text": "a", "evidence_node_ids": ["n1"]}]}, dup)["errors"]


def _n(i, kind, source, ts, **fields):
    return {"id": i, "kind": kind, "source": source, "ts": ts, "fields": fields, "quarantined": fields.pop("_q", False)}


def test_derive_facts_correction_supersedes_and_conflict():
    t0 = datetime(2026, 10, 12, 10, tzinfo=timezone.utc)
    nodes = [
        _n("o1", "order_email", "gmail", t0, po_ref="PO-184", qty_ordered=100, rate=1000, amount=100000, item="Model X"),
        _n("so", "salesorder", "zoho", t0, po_ref="PO-184", qty_ordered=100, rate=1000, customer_id="zc-1001"),
        _n("c1", "delivery_challan", "whatsapp", t0 + timedelta(hours=1), po_ref="PO-184", qty_delivered=60),
        _n("s1", "delivery_record", "sheets", t0 + timedelta(hours=2), po_ref="PO-184", qty_delivered=60),
        _n("inj", "email", "gmail", t0 + timedelta(hours=3), po_ref="PO-184", qty_delivered=999, _q=True),
        _n("note", "note", "media", t0 + timedelta(hours=3), po_ref="PO-184", qty_delivered=5, agent_note=True),
    ]
    f = derive_facts(nodes, "PO-184")
    assert f.delivered_qty == 60 and not f.conflicts and f.billable["amount"] == Decimal("60000.00") and f.customer_id == "zc-1001"
    assert "inj" in f.quarantined_node_ids and "note" not in f.evidence_node_ids
    nodes.append(_n("corr", "correction_message", "whatsapp", t0 + timedelta(hours=4), po_ref="PO-184", qty_delivered=70, is_correction=True))
    f2 = derive_facts(nodes, "PO-184")
    assert f2.delivered_qty == 70 and not f2.conflicts and f2.billable["amount"] == Decimal("70000.00")
    nodes.append(_n("s2", "delivery_record", "sheets", t0 + timedelta(hours=5), po_ref="PO-184", qty_delivered=80))
    f3 = derive_facts(nodes, "PO-184")
    assert f3.conflicts and f3.conflicts[0]["field"] == "delivered_qty"
    tl = {t["stage"]: t["status"] for t in build_timeline(f3)}
    assert tl == {"order": "found", "delivery": "conflict", "invoice": "missing", "payment": "missing"}


def test_billing_rule_parse():
    assert BillingRule.from_any("on_full_delivery").mode == "on_full_delivery"
    assert BillingRule.from_any({"mode": "on_delivery", "delay_days": "3"}).delay_days == 3
