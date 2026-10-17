"""Generate 150 synthetic, labeled order-to-cash cases across the 12 scenario types in the design doc.

    python -m eval.generate            -> eval/data/cases.jsonl (seeded, reproducible)

Each case carries the source records a business would have (order email, WhatsApp dispatch messages, delivery
sheet row, Zoho sales order / invoices / payments, billing rule), the scripted events that happen during the case
(corrections, duplicate deliveries, connector faults, approver decisions) and ground-truth labels.
A stratified 30% held-out `test` split is never used to tune prompts, rules or thresholds.
"""
from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any

SEED = 20261015
N_CASES = 150
TEST_FRACTION = 0.30
OUT = Path(__file__).resolve().parent / "data" / "cases.jsonl"

SCENARIOS = [
    "genuine_missing_invoice", "alternate_reference", "billing_not_due", "partial_delivery", "duplicate_invoice", "partial_payment",
    "conflicting_quantities", "stale_evidence", "duplicate_events", "connector_timeout", "invalid_model_output", "revoked_approval",
]
CUSTOMERS = [
    ("zc-2001", "Shakti Auto Components Pvt Ltd"), ("zc-2002", "Godavari Pumps LLP"), ("zc-2003", "Nandi Fabricators"),
    ("zc-2004", "Kaveri Textiles Pvt Ltd"), ("zc-2005", "Deccan Agro Industries"), ("zc-2006", "Sri Venkateswara Traders"),
]
ITEMS = [("Bearing housing BH-40", 250), ("Pump impeller PI-7", 400), ("Model Y", 800), ("Model X", 1000), ("Gearbox cover GC-2", 1250)]


def _case(i: int, scenario: str, rng: random.Random) -> dict[str, Any]:
    po_n = 300 + i * 3 + rng.randint(0, 2)
    ref = f"PO-{po_n}"
    cust_id, cust = rng.choice(CUSTOMERS)
    item, rate = rng.choice(ITEMS)
    qty = rng.choice([20, 40, 50, 60, 80, 100, 120, 150, 200])
    delivered = qty
    if scenario in ("partial_delivery", "stale_evidence", "conflicting_quantities"):
        delivered = rng.choice([q for q in range(10, qty, 10)] or [qty // 2])
    rule = {"mode": "on_delivery", "delay_days": 0, "allow_partial": True}
    zoho_invoices: list[dict[str, Any]] = []
    payments: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    sheet_qty = delivered
    approver = "approve"
    chaos: list[str] = []

    if scenario == "alternate_reference":
        zoho_invoices.append({"invoice_id": f"ev-inv-{i}", "invoice_number": f"INV-{5000 + i}", "customer_id": cust_id, "customer_name": cust,
                              "reference_number": f"SO-{po_n:05d}", "notes": f"Against order PO {po_n}", "status": "sent", "total": qty * rate,
                              "line_items": [{"name": item, "quantity": qty, "rate": rate, "item_total": qty * rate}]})
    if scenario == "billing_not_due":
        rule = {"mode": "on_delivery", "delay_days": rng.choice([7, 15, 30]), "allow_partial": True}
    if scenario in ("duplicate_invoice", "partial_payment"):
        zoho_invoices.append({"invoice_id": f"ev-inv-{i}a", "invoice_number": f"INV-{6000 + i}", "customer_id": cust_id, "customer_name": cust,
                              "reference_number": ref, "status": "sent", "total": qty * rate, "line_items": [{"name": item, "quantity": qty, "rate": rate, "item_total": qty * rate}]})
    if scenario == "duplicate_invoice":
        zoho_invoices.append({"invoice_id": f"ev-inv-{i}b", "invoice_number": f"INV-{7000 + i}", "customer_id": cust_id, "customer_name": cust,
                              "reference_number": f"{ref}", "status": "sent", "total": qty * rate, "line_items": [{"name": item, "quantity": qty, "rate": rate, "item_total": qty * rate}]})
    if scenario == "partial_payment":
        paid = round(qty * rate * rng.choice([0.25, 0.4, 0.5, 0.6]), 2)
        payments.append({"payment_id": f"ev-pay-{i}", "payment_number": f"PMT-{8000 + i}", "customer_id": cust_id, "amount": paid, "reference_number": ref,
                         "invoice_numbers": f"INV-{6000 + i}", "date": "2026-10-10"})
    if scenario == "conflicting_quantities":
        sheet_qty = min(qty, delivered + rng.choice([10, 20]))
    corrected = None
    if scenario == "stale_evidence":
        corrected = min(qty, delivered + rng.choice([10, 20]))
        events.append({"after": "proposal", "type": "whatsapp", "text": f"Correction: {corrected} delivered", "sheet_qty": corrected})
    if scenario == "duplicate_events":
        events.append({"after": "intake", "type": "replay_email"})
        events.append({"after": "approval", "type": "double_execute"})
    if scenario == "connector_timeout":
        chaos.append("zoho_timeout_once")
    if scenario == "invalid_model_output":
        chaos.append("garbage_output")
    if scenario == "revoked_approval":
        approver = "reject"

    billed_qty = corrected if corrected is not None else delivered
    expected: dict[str, Any]
    if scenario in ("alternate_reference", "billing_not_due"):
        expected = {"is_exception": False, "outcome": "none", "amount": 0, "writes": 0}
    elif scenario in ("duplicate_invoice", "conflicting_quantities"):
        expected = {"is_exception": True, "outcome": "escalate", "amount": 0, "writes": 0}
    elif scenario == "partial_payment":
        expected = {"is_exception": True, "outcome": "send_reminder", "amount": round(qty * rate - payments[0]["amount"], 2), "writes": 1}
    elif scenario == "invalid_model_output":
        expected = {"is_exception": True, "outcome": "escalate", "amount": 0, "writes": 0, "also_acceptable": {"outcome": "create_invoice", "amount": billed_qty * rate}}
    elif scenario == "revoked_approval":
        expected = {"is_exception": True, "outcome": "escalate", "amount": 0, "writes": 0}
    else:
        expected = {"is_exception": True, "outcome": "create_invoice", "amount": billed_qty * rate, "writes": 1}

    chat = f"1203630000{i:05d}@g.us"
    return {
        "id": f"EV-{i:03d}", "scenario": scenario, "ref": ref, "customer_id": cust_id, "customer": cust, "item": item, "rate": rate, "qty": qty,
        "delivered": delivered, "sheet_qty": sheet_qty, "billing_rule": rule, "chat_id": chat,
        "order_email": {"id": f"gm-ev-{i}", "subject": f"Purchase Order {ref}", "text": f"Dear team,\nPlease find our Purchase Order {ref} for {qty} units of {item} at ₹{rate:,} per unit, total ₹{qty * rate:,}.\nRegards,\n{cust}"},
        "dispatch_message": {"id": f"wa-ev-{i}", "text": f"Dispatched {delivered} units against {ref} today. Challan DC-{9000 + i}."},
        "zoho": {"contacts": [{"contact_id": c, "contact_name": n, "mobile": f"9198000{j:05d}", "email": f"ap{j}@example.in"} for j, (c, n) in enumerate(CUSTOMERS)],
                 "salesorders": [{"salesorder_id": f"so-ev-{i}", "salesorder_number": f"SO-{po_n:05d}", "reference_number": ref, "customer_id": cust_id, "customer_name": cust,
                                  "date": "2026-10-01", "status": "confirmed", "total": qty * rate, "line_items": [{"name": item, "quantity": qty, "rate": rate}]}],
                 "invoices": zoho_invoices, "creditnotes": [], "payments": payments, "seq": 9000 + i * 10},
        "events": events, "chaos": chaos, "approver": approver, "expected": expected,
    }


def generate() -> list[dict[str, Any]]:
    rng = random.Random(SEED)
    cases = []
    for i in range(N_CASES):
        cases.append(_case(i, SCENARIOS[i % len(SCENARIOS)], rng))
    # stratified held-out split
    by: dict[str, list[dict[str, Any]]] = {}
    for c in cases:
        by.setdefault(c["scenario"], []).append(c)
    for group in by.values():
        rng.shuffle(group)
        k = max(1, round(len(group) * TEST_FRACTION))
        for j, c in enumerate(group):
            c["split"] = "test" if j < k else "dev"
    return cases


def main() -> None:
    cases = generate()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as fh:
        for c in cases:
            fh.write(json.dumps(c, ensure_ascii=False) + "\n")
    n_test = sum(c["split"] == "test" for c in cases)
    print(f"wrote {len(cases)} cases ({n_test} held-out test) to {OUT}")


if __name__ == "__main__":
    main()
