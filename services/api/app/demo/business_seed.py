"""DEMO_MODE business data for the UX v2 screens: 6 more customers with orders, deliveries, invoices (paid,
open, overdue), payments, reminders, a not-billable mark, a scheduled (bill-after-terms) delivery, a conflicting
delivery count and unlinked messages. Dates are relative to "today" so days-late / ageing always look real.

Seeded cases use fixed numbers RG-1031..RG-1037 (older than the live story), so the PO-184 story still opens RG-1042.
Unlinked messages enter through the SAME secure intake path as live data.
"""
from __future__ import annotations

import copy
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import select

from .. import case_service as cs
from ..audit import append_audit
from ..connectors.registry import get_connector
from ..db import session_scope, utcnow
from ..flags import get_flag, set_flag
from ..models import Case, CaseCheckpoint, NotBillableMark, Reminder
from ..validator import normalize_ref

IST_OFF = timedelta(hours=5, minutes=30)

CONTACTS = [
    {"contact_id": "zc-1003", "contact_name": "Sri Lakshmi Traders", "email": "accounts@srilakshmitraders.in", "mobile": "919811100003", "gst_no": "36AAKFS4321L1Z1", "city": "Hyderabad", "payment_terms": 30},
    {"contact_id": "zc-1004", "contact_name": "Venkat Steel Works", "email": "ap@venkatsteel.in", "mobile": "919811100004", "gst_no": "37AAEFV7788M1Z4", "city": "Vijayawada", "payment_terms": 30},
    {"contact_id": "zc-1005", "contact_name": "Kaveri Agro Foods", "email": "finance@kaveriagro.in", "mobile": "919811100005", "gst_no": "29AACCK2211N1Z7", "city": "Bengaluru", "payment_terms": 45},
    {"contact_id": "zc-1006", "contact_name": "Godavari Plastics", "email": "accounts@godavariplastics.in", "mobile": "919811100006", "gst_no": "37AABCG3344P1Z9", "city": "Rajahmundry", "payment_terms": 30},
    {"contact_id": "zc-1007", "contact_name": "Deccan Packaging LLP", "email": "pay@deccanpack.in", "mobile": "919811100007", "gst_no": "36AAJFD5566Q1Z2", "city": "Hyderabad", "payment_terms": 30},
    {"contact_id": "zc-1008", "contact_name": "Nizam Electricals", "email": "office@nizamelectricals.in", "mobile": "919811100008", "gst_no": "36AAQFN9900R1Z6", "city": "Hyderabad", "payment_terms": 15},
]
CONTACT_EXTRA = {"zc-1001": {"city": "Hyderabad", "payment_terms": 30}, "zc-1002": {"city": "Bengaluru", "payment_terms": 30, "gst_no": "29AAGFO5678K1Z2"}}


def _d(today: date, days: int) -> str:
    return (today + timedelta(days=days)).isoformat()


def _inv(num, cid, name, ref, total, d, *, status="sent", rg=False, paid_on=None, terms=30, gst=True, item="Model X"):
    sub = round(total / 1.18, 2) if gst else float(total)
    due = (date.fromisoformat(d) + timedelta(days=terms)).isoformat()
    inv = {"invoice_id": f"mock-inv-{num.split('-')[1]}", "invoice_number": num, "customer_id": cid, "customer_name": name, "reference_number": ref, "date": d,
           "due_date": due, "status": "paid" if paid_on else status, "sub_total": sub, "tax_total": round(total - sub, 2), "total": float(total),
           "balance": 0.0 if paid_on else float(total), "line_items": [{"name": item, "quantity": 1, "rate": sub, "item_total": sub}],
           "notes": f"Raised via RevenueGuard case RG-{900 + int(num.split('-')[1]) % 100} after approval." if rg else ""}
    return inv


def business_mock(today: date) -> dict[str, Any]:
    """Extra Zoho / sheet / bank records, relative to today."""
    t = today
    month_start = t.replace(day=1)

    def this_month(days_back: int) -> str:
        return max(month_start, t - timedelta(days=days_back)).isoformat()

    last_month_end = month_start - timedelta(days=1)
    lm = lambda day: last_month_end.replace(day=min(day, last_month_end.day)).isoformat()  # noqa: E731

    def months_ago(n: int, day: int) -> str:
        y, m = t.year, t.month - n
        while m <= 0:
            m += 12
            y -= 1
        return date(y, m, min(day, 28)).isoformat()

    invoices, payments = [], []

    def paid(inv, after_days):
        pd = (date.fromisoformat(inv["date"]) + timedelta(days=after_days)).isoformat()
        inv.update(status="paid", balance=0.0)
        payments.append({"payment_id": f"pay-{inv['invoice_number']}", "payment_number": f"PMT-{inv['invoice_number'][4:]}", "customer_id": inv["customer_id"],
                         "amount": inv["total"], "reference_number": inv["reference_number"], "invoice_numbers": inv["invoice_number"], "date": pd})
        return inv

    # --- overdue (To collect): 85,000 + 62,500 + 38,000 + 30,000 = 2,15,500
    invoices.append(_inv("INV-2190", "zc-1001", "Example Customer Pvt Ltd", "PO-160", 85000, _d(t, -71)))
    invoices.append(_inv("INV-2177", "zc-1004", "Venkat Steel Works", "PO-171", 62500, _d(t, -52)))
    invoices.append(_inv("INV-2203", "zc-1003", "Sri Lakshmi Traders", "PO-180", 38000, _d(t, -39)))
    invoices.append(_inv("INV-2185", "zc-1006", "Godavari Plastics", "PO-165", 30000, _d(t, -95)))
    # --- under-billed: Kaveri PO-176, 40 of 55 delivered billed (open, not yet due)
    kav = _inv("INV-2198", "zc-1005", "Kaveri Agro Foods", "PO-176", 118000, _d(t, -4), terms=45, item="Model Z")
    kav["line_items"] = [{"name": "Model Z", "quantity": 40, "rate": 2500, "item_total": 100000}]
    kav["sub_total"], kav["tax_total"] = 100000.0, 18000.0
    invoices.append(kav)
    # --- recovered this month via RevenueGuard: 1,18,000 + 59,000 + 70,800 + 47,200 + 45,000 = 3,40,000 (open, not due)
    for num, cid, name, ref, amt, back in (("INV-2205", "zc-1001", "Example Customer Pvt Ltd", "PO-172", 118000, 12), ("INV-2209", "zc-1005", "Kaveri Agro Foods", "PO-168", 59000, 9),
                                           ("INV-2211", "zc-1007", "Deccan Packaging LLP", "PO-174", 70800, 7), ("INV-2214", "zc-1004", "Venkat Steel Works", "PO-175", 47200, 5),
                                           ("INV-2216", "zc-1008", "Nizam Electricals", "PO-178", 45000, 2)):
        invoices.append(_inv(num, cid, name, ref, amt, this_month(back), rg=True))
    # --- recovered last month via RevenueGuard (paid): 1,10,000 + 75,000 = 1,85,000
    invoices.append(paid(_inv("INV-2150", "zc-1003", "Sri Lakshmi Traders", "PO-150", 110000, lm(6), rg=True), 24))
    invoices.append(paid(_inv("INV-2158", "zc-1007", "Deccan Packaging LLP", "PO-155", 75000, lm(14), rg=True), 21))
    # --- older RevenueGuard months for the report
    for i, (num, cid, name, amt) in enumerate((("INV-2101", "zc-1001", "Example Customer Pvt Ltd", 96000), ("INV-2112", "zc-1004", "Venkat Steel Works", 140000),
                                               ("INV-2120", "zc-1005", "Kaveri Agro Foods", 64000), ("INV-2131", "zc-1003", "Sri Lakshmi Traders", 88000))):
        invoices.append(paid(_inv(num, cid, name, f"PO-1{20 + i}", amt, months_ago(5 - i, 10), rg=True), 30 + 5 * i))
    # --- payment history for days-to-pay (non RevenueGuard)
    hist = [("zc-1001", "Example Customer Pvt Ltd", [44, 47, 51]), ("zc-1003", "Sri Lakshmi Traders", [28, 25, 31]), ("zc-1004", "Venkat Steel Works", [41, 38, 36]),
            ("zc-1005", "Kaveri Agro Foods", [40, 44]), ("zc-1006", "Godavari Plastics", [72, 66]), ("zc-1007", "Deccan Packaging LLP", [22, 19, 24]),
            ("zc-1008", "Nizam Electricals", [12, 14])]
    n = 2040
    for cid, name, delays in hist:
        for k, dl in enumerate(delays):
            n += 1
            invoices.append(paid(_inv(f"INV-{n}", cid, name, f"PO-{n - 1900}", 40000 + 7000 * k, months_ago(4 - k, 5)), dl))
    salesorders = [
        {"salesorder_id": "so-201", "salesorder_number": "SO-00201", "reference_number": "PO-201", "customer_id": "zc-1003", "customer_name": "Sri Lakshmi Traders", "date": _d(t, -9), "status": "confirmed", "total": 148000, "line_items": [{"name": "Model X", "quantity": 148, "rate": 1000}]},
        {"salesorder_id": "so-198", "salesorder_number": "SO-00198", "reference_number": "PO-198", "customer_id": "zc-1004", "customer_name": "Venkat Steel Works", "date": _d(t, -12), "status": "confirmed", "total": 120000, "line_items": [{"name": "Model X", "quantity": 120, "rate": 1000}]},
        {"salesorder_id": "so-176", "salesorder_number": "SO-00176", "reference_number": "PO-176", "customer_id": "zc-1005", "customer_name": "Kaveri Agro Foods", "date": _d(t, -14), "status": "confirmed", "total": 150000, "line_items": [{"name": "Model Z", "quantity": 60, "rate": 2500}]},
        {"salesorder_id": "so-188", "salesorder_number": "SO-00188", "reference_number": "PO-188", "customer_id": "zc-1006", "customer_name": "Godavari Plastics", "date": _d(t, -8), "status": "confirmed", "total": 40000, "line_items": [{"name": "Model X", "quantity": 40, "rate": 1000}]},
        {"salesorder_id": "so-193", "salesorder_number": "SO-00193", "reference_number": "PO-193", "customer_id": "zc-1007", "customer_name": "Deccan Packaging LLP", "date": _d(t, -10), "status": "confirmed", "total": 96000, "line_items": [{"name": "Model X", "quantity": 96, "rate": 1000}]},
        {"salesorder_id": "so-190", "salesorder_number": "SO-00190", "reference_number": "PO-190", "customer_id": "zc-1008", "customer_name": "Nizam Electricals", "date": _d(t, -6), "status": "confirmed", "total": 18000, "line_items": [{"name": "Model Y", "quantity": 12, "rate": 1500}]},
    ]
    sheet = [
        ("PO-201", "Sri Lakshmi Traders", "Model X", 148, 148, -6), ("PO-198", "Venkat Steel Works", "Model X", 120, 109, -5), ("PO-176", "Kaveri Agro Foods", "Model Z", 60, 55, -4),
        ("PO-188", "Godavari Plastics", "Model X", 40, 25, -2), ("PO-193", "Deccan Packaging LLP", "Model X", 96, 96, -6), ("PO-190", "Nizam Electricals", "Model Y", 12, 12, -3),
    ]
    rows = [{"row": 10 + i, "po_ref": p, "customer": c, "item": it, "qty_ordered": o, "qty_delivered": dl, "qty_pending": o - dl, "updated_at": _d(t, off)} for i, (p, c, it, o, dl, off) in enumerate(sheet)]
    bank = [{"id": f"bank-{p['payment_id']}", "date": p["date"], "narration": f"NEFT CR {p['invoice_numbers']} {p['reference_number']}", "reference": p["payment_number"],
             "credit": float(p["amount"]), "debit": 0.0, "balance": 0.0} for p in payments[:6]]
    return {"invoices": invoices, "payments": payments, "salesorders": salesorders, "rows": rows, "bank": bank}


async def _extend_mock(tid: str, today: date) -> None:
    data = business_mock(today)
    async with session_scope() as s:
        z = await get_connector(s, tid, "zoho")
        cfg = copy.deepcopy(z.config or {})
        m = cfg.setdefault("mock", {})
        contacts = m.setdefault("contacts", [])
        for c in contacts:
            c.update({k: v for k, v in CONTACT_EXTRA.get(c["contact_id"], {}).items() if k not in c})
        have = {c["contact_id"] for c in contacts}
        contacts += [dict(c) for c in CONTACTS if c["contact_id"] not in have]
        for key in ("invoices", "payments", "salesorders"):
            idk = {"invoices": "invoice_id", "payments": "payment_id", "salesorders": "salesorder_id"}[key]
            cur = m.setdefault(key, [])
            ids = {x.get(idk) for x in cur}
            cur += [x for x in data[key] if x[idk] not in ids]
        z.config = cfg
        sh = await get_connector(s, tid, "sheets")
        cfg = copy.deepcopy(sh.config or {})
        m = cfg.setdefault("mock", {})
        rows = m.setdefault("rows", [])
        have = {r["po_ref"] for r in rows}
        rows += [r for r in data["rows"] if r["po_ref"] not in have]
        sh.config = cfg
        b = await get_connector(s, tid, "bank")
        cfg = copy.deepcopy(b.config or {})
        brows = cfg.setdefault("rows", [])
        have = {r["id"] for r in brows}
        brows += [r for r in data["bank"] if r["id"] not in have]
        b.config = cfg


def _ts(today: date, days: int, hour: int = 11) -> datetime:
    return datetime.combine(today + timedelta(days=days), time(hour, 0), tzinfo=timezone.utc) - IST_OFF


async def _seed_case(s, tid: str, number: str, po: str, customer: str, cid: str, exc: str, created_days: int, today: date, nodes: list[dict[str, Any]],
                     path: list[str]) -> Case:
    c = Case(tenant_id=tid, case_number=number, state="INTAKE", exception_type=exc, severity="medium", po_ref=po, po_ref_norm=normalize_ref(po), customer=customer,
             title=f"{po} · {customer}", created_at=_ts(today, created_days, 10))
    s.add(c)
    await s.flush()
    s.add(CaseCheckpoint(tenant_id=tid, case_id=c.id, seq=1, from_state=None, state="INTAKE", reason="case opened at intake (seeded demo history)", payload={"ref": po},
                         evidence_version=0, correlation_id=c.correlation_id, created_at=_ts(today, created_days, 10)))
    await append_audit(s, tid, "case.opened", "demo-seed", {"case_number": number, "po_ref": po}, c.id, c.correlation_id)
    for n in nodes:
        n = dict(n)
        days = n.pop("days")
        f = dict(n.pop("fields"))
        f.setdefault("po_ref", po)
        f.setdefault("customer", customer)
        f.setdefault("customer_id", cid)
        await cs.add_evidence(s, c, tid, ts=_ts(today, days, n.pop("hour", 11)), fields=f, actor="demo-seed", **n)
    for st in path:
        await cs.transition(s, c, st, {"TRIAGED": "triage: delivered goods not billed", "WATCHING": "collect evidence across connected sources",
                                       "EVIDENCE_READY": "order and delivery evidence linked", "VALIDATED": "deterministic validator computed facts",
                                       "INVESTIGATING": "conflicting evidence: look for corrections"}.get(st, st), actor="demo-seed")
    c.facts = (await cs.compute_facts(s, c)).to_json()
    return c


async def seed_business(tid: str | None = None) -> dict[str, Any]:
    """Idempotent: skips when the seeded cases already exist."""
    from ..sync import default_tenant_id

    tid = tid or await default_tenant_id()
    today = (utcnow() + IST_OFF).date()
    async with session_scope() as s:
        if (await s.execute(select(Case.id).where(Case.tenant_id == tid, Case.case_number == "RG-1031"))).first():
            return {"ok": True, "skipped": "already seeded"}
        for name in ("gmail", "sheets", "drive", "zoho", "whatsapp", "bank"):
            c = await get_connector(s, tid, name)
            if c.status != "connected":
                c.status, c.authorized_by, c.authorized_at, c.last_sync_at = "connected", "admin@demo.in", utcnow(), utcnow()
        rules = dict(await get_flag(s, tid, "billing_rules", None) or {"default": {"mode": "on_delivery", "delay_days": 0, "allow_partial": True}})
        rules["customers"] = {**(rules.get("customers") or {}), "zc-1007": {"mode": "on_delivery", "delay_days": 7, "allow_partial": True}}
        await set_flag(s, tid, "billing_rules", rules)
    await _extend_mock(tid, today)
    po_email = lambda po, qty, rate, item, days: {"kind": "order_email", "source": "gmail", "source_id": f"seed-po-{po}", "title": f"Purchase Order {po} - {item}",  # noqa: E731
                                                  "excerpt": f"Please supply {qty} units of {item} at Rs {rate} per unit against {po}.", "days": days,
                                                  "fields": {"doc_type": "order", "qty_ordered": qty, "rate": rate, "item": item, "amount": qty * rate}}
    so_node = lambda po, qty, rate, item, days: {"kind": "salesorder", "source": "zoho", "source_id": f"so:so-{po[3:]}", "title": f"Zoho sales order SO-00{po[3:]} ({po})",  # noqa: E731
                                                 "days": days, "fields": {"qty_ordered": qty, "rate": rate, "item": item, "amount": qty * rate}}
    sheet = lambda po, o, dl, days: {"kind": "delivery_record", "source": "sheets", "source_id": f"seed-row-{po}", "title": f"Delivery sheet row: {po}", "days": days,  # noqa: E731
                                     "excerpt": f"po_ref={po}, qty_ordered={o}, qty_delivered={dl}, qty_pending={o - dl}", "fields": {"qty_ordered": o, "qty_delivered": dl, "qty_pending": o - dl}}
    challan = lambda po, dl, days, who: {"kind": "delivery_challan", "source": "whatsapp", "source_id": f"seed-challan-{po}", "title": f"WhatsApp image from {who}",  # noqa: E731
                                         "mime": "image/png", "days": days, "derived_text": f"DELIVERY CHALLAN PO Ref: {po} Qty Dispatched: {dl}",
                                         "excerpt": f"Challan for {po}", "fields": {"doc_type": "delivery", "qty_delivered": dl}}
    async with session_scope() as s:
        w = "WATCHING"
        await _seed_case(s, tid, "RG-1031", "PO-201", "Sri Lakshmi Traders", "zc-1003", "missing_invoice", -9, today,
                         [po_email("PO-201", 148, 1000, "Model X", -9), sheet("PO-201", 148, 148, -6)], ["TRIAGED", w])
        await _seed_case(s, tid, "RG-1032", "PO-198", "Venkat Steel Works", "zc-1004", "partial_delivery", -12, today,
                         [so_node("PO-198", 120, 1000, "Model X", -12), challan("PO-198", 109, -5, "Srinu (Dispatch)"), sheet("PO-198", 120, 109, -5)], ["TRIAGED", w])
        kav = await _seed_case(s, tid, "RG-1033", "PO-176", "Kaveri Agro Foods", "zc-1005", "partial_delivery", -14, today,
                               [so_node("PO-176", 60, 2500, "Model Z", -14), challan("PO-176", 55, -4, "Srinu (Dispatch)"),
                                {"kind": "invoice", "source": "zoho", "source_id": "inv:mock-inv-2198", "title": "Zoho invoice INV-2198 ref PO-176", "days": -4,
                                 "fields": {"invoice_id": "mock-inv-2198", "invoice_number": "INV-2198", "reference_number": "PO-176", "total": 118000, "status": "sent", "qty": 40}}],
                               ["TRIAGED", w])
        god = await _seed_case(s, tid, "RG-1034", "PO-188", "Godavari Plastics", "zc-1006", "quantity_conflict", -8, today,
                               [so_node("PO-188", 40, 1000, "Model X", -8), challan("PO-188", 30, -3, "Ravi (Godown)"), sheet("PO-188", 40, 25, -2)],
                               ["TRIAGED", w, "EVIDENCE_READY", "VALIDATED", "INVESTIGATING"])
        await cs.open_escalation(s, god, "conflict", {"message": "evidence sources disagree", "conflicts": god.facts.get("conflicts")})
        await cs.transition(s, god, "ESCALATED", "escalated: conflict", actor="demo-seed")
        dec = await _seed_case(s, tid, "RG-1035", "PO-193", "Deccan Packaging LLP", "zc-1007", "billing_not_due", -10, today,
                               [po_email("PO-193", 96, 1000, "Model X", -10), sheet("PO-193", 96, 96, -6)], ["TRIAGED", w])
        dec.watch_until = _ts(today, 1, 9)
        niz = await _seed_case(s, tid, "RG-1036", "PO-190", "Nizam Electricals", "zc-1008", "missing_invoice", -6, today,
                               [po_email("PO-190", 12, 1500, "Model Y", -6),
                                {"kind": "chat_message", "source": "whatsapp", "source_id": "seed-chat-PO-190", "title": "WhatsApp from Priya (Sales)", "days": -3,
                                 "excerpt": "12 free replacement units of Model Y sent to Nizam for PO-190", "fields": {"qty_delivered": 12}}], ["TRIAGED", w])
        s.add(NotBillableMark(tenant_id=tid, case_id=niz.id, reason="replacement", note="Free replacement for damaged units", marked_by="ops@demo.in"))
        await append_audit(s, tid, "bill.not_billable", "ops@demo.in", {"reason": "replacement"}, niz.id, niz.correlation_id)
        for case in (kav,):
            case.watch_until = _ts(today, 365)
        for num in ("RG-1031", "RG-1032", "RG-1033", "RG-1036"):
            c = (await s.execute(select(Case).where(Case.tenant_id == tid, Case.case_number == num))).scalar_one()
            c.watch_until = _ts(today, 365)  # history: not re-driven by sweeps
        # reminder history (WhatsApp receipts)
        for inv, cid, stage, status, amt, days, note in (("INV-2190", "zc-1001", 7, "sent", 85000, -34, ""), ("INV-2190", "zc-1001", 15, "read", 85000, -26, ""),
                                                         ("INV-2177", "zc-1004", 15, "replied", 62500, -7, "Customer replied: will pay on Friday"),
                                                         ("INV-2203", "zc-1003", 7, "sent", 38000, -2, "")):
            s.add(Reminder(tenant_id=tid, invoice_number=inv, customer_id=cid, stage=stage, status=status, amount=amt, note=note, created_by="finance@demo.in",
                           message=f"Reminder ({stage} days) for {inv}", created_at=_ts(today, days)))
    # a reminder waiting for approval (normal customer-message approval)
    from ..reminders import draft_reminder

    card = await draft_reminder(tid, "INV-2190", 30, "ops@demo.in", case_number="RG-1037")
    # unlinked messages through secure intake
    from ..intake import IntakeItem, intake

    unl = []
    for item in (
        IntakeItem(source="whatsapp", source_id="seed-unlinked-1", sender="919800000077@s.whatsapp.net", sender_name="Ravi (Example Customer)", chat_id="919800000077@s.whatsapp.net",
                   text="Exmpl Cust: 20 boxes delivered today, Model X. Please bill against 184.", ts=_ts(today, -1, 16)),
        IntakeItem(source="gmail", source_id="seed-unlinked-2", sender="Accounts <accounts@srilakshmitraders.in>", sender_name="Sri Lakshmi accounts",
                   subject="Payment done", text="Dear sir, payment of Rs 38,000 done via NEFT for last month bill. Kindly confirm.", ts=_ts(today, -1, 12)),
        IntakeItem(source="whatsapp", source_id="seed-unlinked-3", sender="919811100099@s.whatsapp.net", sender_name="Srinu (Dispatch)", chat_id="919811100099@s.whatsapp.net",
                   text="Venkat garu side 11 boxes dispatched today, balance cleared", ts=_ts(today, 0, 9)),
    ):
        r = await intake(tid, item, actor="demo-seed", enqueue=False)
        unl.append(r.get("status"))
    async with session_scope() as s:
        await append_audit(s, tid, "demo.business_seeded", "demo", {"cases": 7, "unlinked": unl})
    return {"ok": True, "cases": ["RG-1031", "RG-1032", "RG-1033", "RG-1034", "RG-1035", "RG-1036", card["case_ref"]], "unlinked": unl}


async def showcase() -> dict[str, Any]:
    """Reset, seed business data, then play the PO-184 story to the ₹70,000 approval (after the 60->70 correction,
    with the injection quarantined) and bring PO-185 (₹2,00,000) to its two-approver approval."""
    from .scenes import _Suppress, _tenant_and_users, beat_9, play_scene, reset_demo

    await reset_demo()
    r = await play_scene(10)
    tid, users = await _tenant_and_users()
    async with _Suppress():
        p185 = await beat_9(tid, users)
    return {"ok": True, "scenes_done": r["scenes_done"], "po_185": p185.get("state_after"), "cases": r["cases"]}
