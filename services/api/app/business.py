"""Business view (UX v2): derives To bill / To collect / Customers / Money Flow / Reports / case summaries from the
existing cases, evidence, validator facts, approvals, actions and the accounting (Zoho) + bank data.

Nothing here writes money or messages. Every number comes from the validator (case facts) or from the accounting
records; sentences come from plain_language templates.
"""
from __future__ import annotations

import csv
import difflib
import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select

from . import case_service as cs
from . import plain_language as pl
from .connectors.base import ConnectorError
from .connectors.registry import adapter, get_connector
from .db import session_scope
from .flags import now as vnow
from .gst import gst_preview, inr, state_code
from .models import (
    Action, AgentRun, Approval, Case, CaseCheckpoint, EvidenceNode, NotBillableMark, Proposal, Reminder, Snooze, ToolCall, User,
    Verification,
)
from .settings_service import get_tenant_settings, mask_phone
from .validator import normalize_ref, refs_match

IST = ZoneInfo("Asia/Kolkata")
COLLECTION_TYPE = "overdue_payment"
PROBLEM_STATES = {"PAUSED", "ESCALATED", "BLOCKED"}


# =============================================================================== helpers
def to_int(v: Any) -> int:
    try:
        return int(Decimal(str(v or 0)).quantize(Decimal(1)))
    except Exception:  # noqa: BLE001
        return 0


def parse_date(v: Any) -> date | None:
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return (v if v.tzinfo else v.replace(tzinfo=timezone.utc)).astimezone(IST).date()
    if isinstance(v, date):
        return v
    s = str(v).strip()
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date() if "T" in s else date.fromisoformat(s[:10])
    except ValueError:
        m = re.search(r"(\d{4}-\d{2}-\d{2})", s)
        return date.fromisoformat(m.group(1)) if m else None


def iso(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    return str(v)


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")


def invoice_taxable(inv: dict[str, Any]) -> float:
    if inv.get("sub_total") is not None:
        return float(inv["sub_total"])
    items = inv.get("line_items") or []
    if items:
        return float(sum(float(li.get("item_total") or float(li.get("quantity", 0)) * float(li.get("rate", 0))) for li in items))
    return float(inv.get("total") or 0)


def is_rg_invoice(inv: dict[str, Any]) -> bool:
    return "RevenueGuard" in (inv.get("notes") or "") or any(cf.get("api_name") == "cf_rg_idempotency_key" for cf in inv.get("custom_fields") or [])


def proof_for_node(n: EvidenceNode | dict[str, Any]) -> dict[str, Any] | None:
    d = n if isinstance(n, dict) else cs.node_dict(n)
    flds = d.get("fields") or {}
    if d.get("quarantined") or d.get("kind") in ("note", "search_result", "contact", "chat_memory") or flds.get("negative_finding") or flds.get("agent_note") or flds.get("status") in ("deleted", "duplicate"):
        return None
    src, kind, mime = d.get("source"), d.get("kind") or "", (d.get("mime") if isinstance(n, dict) else getattr(n, "mime", None)) or ""
    if not mime and d.get("media_url") and isinstance(n, EvidenceNode):
        mime = n.mime or ""
    doc = flds.get("doc_type")
    if src == "sheets":
        return {"kind": "sheet", "label": "Sheet", "node_id": d["id"]}
    if src == "bank":
        return {"kind": "bank", "label": "Bank", "node_id": d["id"]}
    if src == "zoho":
        if kind == "invoice":
            return {"kind": "zoho", "label": flds.get("invoice_number") or "Invoice", "node_id": d["id"]}
        if kind == "payment":
            return {"kind": "zoho", "label": "Payment", "node_id": d["id"]}
        if kind == "salesorder":
            return {"kind": "zoho", "label": "Sales order", "node_id": d["id"]}
        return None
    if src == "manual":
        return {"kind": "manual", "label": "Correction", "node_id": d["id"]}
    if mime.startswith("audio/") or kind == "voice_note":
        return {"kind": "voice", "label": "Voice note", "node_id": d["id"]}
    if mime.startswith("image/") or kind in ("delivery_challan", "photo"):
        return {"kind": "photo", "label": "Challan" if (doc == "delivery" or kind == "delivery_challan") else "Photo", "node_id": d["id"]}
    if mime == "application/pdf" or kind in ("po_document", "invoice_document"):
        return {"kind": "pdf", "label": "PO" if (doc == "order" or kind == "po_document") else "PDF", "node_id": d["id"]}
    if src == "gmail":
        return {"kind": "email", "label": "PO" if (doc == "order" or kind == "order_email") else "Email", "node_id": d["id"]}
    if src == "whatsapp":
        return {"kind": "whatsapp", "label": "Correction" if (flds.get("is_correction") or kind == "correction_message") else "Chat", "node_id": d["id"]}
    if src == "media":
        return {"kind": "pdf", "label": "Document", "node_id": d["id"]}
    return None


def proofs_for_nodes(nodes: list[EvidenceNode], limit: int = 5) -> list[dict[str, Any]]:
    out, seen = [], set()
    for n in nodes:
        p = proof_for_node(n)
        if p and p["label"] not in seen:
            seen.add(p["label"])
            out.append(p)
    order = {"PO": 0, "Email": 1, "Challan": 2, "Photo": 3, "Voice note": 4, "Chat": 5, "Correction": 6, "Sheet": 7, "Sales order": 8}
    out.sort(key=lambda p: order.get(p["label"], 9))
    return out[:limit]


# =============================================================================== world (one read of everything)
@dataclass
class CaseView:
    case: Case
    facts: dict[str, Any]
    nodes: list[EvidenceNode]
    customer_id: str | None
    customer: str | None
    billed_qty: float
    billed_by_us: bool
    invoice_number: str | None
    not_billable: NotBillableMark | None
    approvals: list[Approval] = field(default_factory=list)


@dataclass
class World:
    tenant_id: str
    now: datetime
    today: date
    settings: dict[str, Any]
    contacts: list[dict[str, Any]]
    invoices: list[dict[str, Any]]
    payments: list[dict[str, Any]]
    salesorders: list[dict[str, Any]]
    sheet_rows: list[dict[str, Any]]
    cases: list[CaseView]
    collection_cases: list[Case]
    reminders: list[Reminder]
    snoozes: list[Snooze]
    zoho_ok: bool

    def contact(self, cid: str | None) -> dict[str, Any] | None:
        return next((c for c in self.contacts if c.get("contact_id") == cid), None) if cid else None

    def contact_by_name(self, name: str | None) -> dict[str, Any] | None:
        if not name:
            return None
        n = name.strip().lower()
        return next((c for c in self.contacts if (c.get("contact_name") or "").strip().lower() == n), None)

    def terms(self, cid: str | None) -> int:
        c = self.contact(cid) or {}
        return int(c.get("payment_terms") or self.settings.get("default_terms_days") or 30)

    def paid_for_invoice(self, inv: dict[str, Any]) -> tuple[float, date | None]:
        num = inv.get("invoice_number") or ""
        total, last = 0.0, None
        for p in self.payments:
            nums = [x.strip() for x in str(p.get("invoice_numbers") or "").split(",")]
            if num and num in nums:
                total += float(p.get("amount") or 0)
                d = parse_date(p.get("date"))
                last = max(last, d) if (last and d) else (d or last)
        return total, last

    def balance(self, inv: dict[str, Any]) -> float:
        if inv.get("status") in ("void",):
            return 0.0
        if inv.get("status") == "paid":
            return 0.0
        if inv.get("balance") is not None and not self.paid_for_invoice(inv)[0]:
            return float(inv["balance"])
        return max(0.0, float(inv.get("total") or 0) - self.paid_for_invoice(inv)[0])

    def due_date(self, inv: dict[str, Any]) -> date | None:
        d = parse_date(inv.get("due_date"))
        if d:
            return d
        dd = parse_date(inv.get("date"))
        return dd + timedelta(days=self.terms(inv.get("customer_id"))) if dd else None


async def _safe_list(fn) -> tuple[list[dict[str, Any]], bool]:
    try:
        return list(await fn()), True
    except ConnectorError:
        return [], False
    except Exception:  # noqa: BLE001
        return [], False


async def load_world(s, tenant_id: str, with_cases: bool = True) -> World:
    now = await vnow(s, tenant_id)
    settings = await get_tenant_settings(s, tenant_id)
    zoho_ok = True
    try:
        z = await adapter(s, tenant_id, "zoho")
        contacts, ok1 = await _safe_list(z.list_contacts)
        invoices, ok2 = await _safe_list(z.list_invoices)
        payments, ok3 = await _safe_list(z.list_payments)
        salesorders, ok4 = await _safe_list(z.list_salesorders)
        zoho_ok = ok1 and ok2 and ok3 and ok4
    except ConnectorError:
        contacts, invoices, payments, salesorders, zoho_ok = [], [], [], [], False
    try:
        sheet_rows = list(await (await adapter(s, tenant_id, "sheets")).read_delivery(None))
    except Exception:  # noqa: BLE001
        sheet_rows = []
    cases: list[CaseView] = []
    collection: list[Case] = []
    if with_cases:
        rows = (await s.execute(select(Case).where(Case.tenant_id == tenant_id).order_by(Case.created_at))).scalars().all()
        marks = {m.case_id: m for m in (await s.execute(select(NotBillableMark).where(NotBillableMark.tenant_id == tenant_id, NotBillableMark.active.is_(True)))).scalars().all()}
        aps = (await s.execute(select(Approval).where(Approval.tenant_id == tenant_id).order_by(Approval.created_at))).scalars().all()
        acts = (await s.execute(select(Action).where(Action.tenant_id == tenant_id, Action.status == "succeeded", Action.type == "create_invoice"))).scalars().all()
        for c in rows:
            if c.exception_type == COLLECTION_TYPE:
                collection.append(c)
                continue
            f = await cs.compute_facts(s, c)
            fj = f.to_json()
            nodes = await cs.case_nodes(s, c)
            billed_qty = 0.0
            inv_no = None
            for d in f.duplicates:
                src = next((i for i in f.invoices if i.get("invoice_id") == d["invoice_id"]), {})
                billed_qty += float(src.get("qty") or 0)
                inv_no = inv_no or d.get("invoice_number")
            mine = [a for a in acts if a.case_id == c.id]
            if mine:
                inv_no = (mine[-1].response or {}).get("invoice_number") or inv_no
            cid = f.customer_id
            cust = f.customer_name or c.customer
            if not cid:
                ct = next((x for x in contacts if (x.get("contact_name") or "").lower() == (cust or "").lower()), None)
                cid = ct["contact_id"] if ct else (f"name:{slug(cust)}" if cust else None)
            cases.append(CaseView(c, fj, nodes, cid, cust, billed_qty, bool(mine), inv_no, marks.get(c.id), [a for a in aps if a.case_id == c.id]))
    reminders = list((await s.execute(select(Reminder).where(Reminder.tenant_id == tenant_id).order_by(Reminder.created_at))).scalars().all())
    snoozes = list((await s.execute(select(Snooze).where(Snooze.tenant_id == tenant_id).order_by(Snooze.created_at))).scalars().all())
    return World(tenant_id, now, now.astimezone(IST).date(), settings, contacts, invoices, payments, salesorders, sheet_rows, cases, collection,
                 reminders, snoozes, zoho_ok)


# =============================================================================== To bill
def _gst_for(w: World, cv: CaseView, taxable_lines: list[dict[str, Any]]) -> dict[str, Any]:
    c = w.contact(cv.customer_id) or {}
    return gst_preview(taxable_lines, w.settings, c.get("gst_no") or c.get("gstin"))


def bill_status(cv: CaseView) -> str | None:
    """not_billed | partial | needs_check | scheduled | not_billable | None (nothing to bill)."""
    c, f = cv.case, cv.facts
    if cv.not_billable:
        return "not_billable"
    if c.state == "CLOSED" or c.state == "INTAKE":
        return None
    billable = f.get("billable") or {}
    due = float(billable.get("amount_when_due") or 0)
    if f.get("delivered_qty") is None:
        return "needs_check" if c.state in PROBLEM_STATES and f.get("order_qty") is not None and f.get("conflicts") else None
    if f.get("conflicts") or c.state in ("ESCALATED", "BLOCKED"):
        return "needs_check"
    if due <= 0:
        return None
    if billable.get("not_due"):
        return "scheduled"
    if c.state == "PAUSED":
        return "needs_check"
    if cv.billed_qty > 0:
        return "partial"
    return "not_billed"


def plain_facts(w: World, cv: CaseView) -> dict[str, Any]:
    f = dict(cv.facts)
    f.update(customer=cv.customer, billed_qty=cv.billed_qty, billed_by_us=cv.billed_by_us, invoice_number=cv.invoice_number)
    by_id = {n.id: n for n in cv.nodes}
    alias = {}
    for d in f.get("delivery_sources") or []:
        n = by_id.get(d.get("node_id"))
        if n is not None and ((n.mime or "").startswith("image/") or n.kind in ("delivery_challan", "photo")):
            alias[d["source"]] = "media"  # a challan photo is called "Challan", not "WhatsApp"
    f["source_alias"] = alias
    billable = f.get("billable") or {}
    if billable.get("billable_qty"):
        f["gst"] = _gst_for(w, cv, [{"item": f.get("item") or "Item", "qty": billable["billable_qty"], "rate": billable.get("rate") or f.get("rate") or 0}])
    if cv.billed_by_us:
        act_total = next((a for a in cv.approvals if a.status == "approved"), None)
        f["amount"] = float(act_total.amount) if act_total and act_total.amount is not None else None
    return f


def to_bill_row(w: World, cv: CaseView, lang: str = "en") -> dict[str, Any] | None:
    status = bill_status(cv)
    if status is None:
        return None
    f = cv.facts
    billable = f.get("billable") or {}
    amount = 0 if status == "not_billable" else to_int(billable.get("amount_when_due") or billable.get("amount") or 0)
    delivered_at = parse_date(f.get("delivered_at")) or parse_date(cv.case.created_at)
    pf = plain_facts(w, cv)
    exp = pl.explain(pf, lang, cv.case.exception_type)
    headline = exp["headline"]
    if status == "not_billable":
        reason = {"sample": "Sample", "replacement": "Free replacement units", "returned": "Goods returned", "billed_elsewhere": "Billed in another system",
                  "other": "Not billable"}.get(cv.not_billable.reason, "Not billable")
        headline = f"{reason}. Marked not billable by {cv.not_billable.marked_by.split('@')[0]}."
    return {
        "case_ref": cv.case.case_number, "customer_id": cv.customer_id, "customer": cv.customer, "po_ref": cv.case.po_ref, "headline": headline,
        "status": status, "waiting_days": max(0, (w.today - delivered_at).days) if delivered_at else 0, "amount": amount,
        "proofs": proofs_for_nodes(cv.nodes), "due_at": billable.get("due_at") if status == "scheduled" else None,
    }


def bill_rows(w: World, status: str | None = None, customer: str | None = None, q: str | None = None, lang: str = "en") -> list[dict[str, Any]]:
    rows = [r for r in (to_bill_row(w, cv, lang) for cv in w.cases) if r]
    want = set((status or "").split(",")) - {""}
    if want:
        rows = [r for r in rows if r["status"] in want]
    else:
        rows = [r for r in rows if r["status"] != "not_billable"]  # marked items leave the To bill list
    if customer:
        rows = [r for r in rows if r["customer_id"] == customer or (r["customer"] or "").lower() == customer.lower()]
    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in " ".join(str(r.get(k) or "") for k in ("case_ref", "customer", "po_ref", "headline")).lower()]
    rows.sort(key=lambda r: (r["status"] == "scheduled", -r["amount"]))
    return rows


# =============================================================================== To collect
def _reminder_view(w: World, inv_no: str) -> tuple[dict[str, Any], Reminder | None]:
    rs = [r for r in w.reminders if r.invoice_number == inv_no and r.status not in ("rejected", "expired")]
    if not rs:
        return {"stage": 0, "status": "none"}, None
    r = rs[-1]
    return {"stage": int(r.stage), "status": r.status if r.status in ("draft", "sent", "read", "replied") else "draft"}, r


def chase_rows(w: World, bucket: str = "all") -> list[dict[str, Any]]:
    out = []
    for inv in w.invoices:
        if inv.get("status") in ("void", "paid", "draft") and inv.get("status") != "draft":
            continue
        if inv.get("status") == "draft" and not inv.get("due_date"):
            continue
        bal = w.balance(inv)
        due = w.due_date(inv)
        if bal <= 0 or due is None or due >= w.today:
            continue
        days = (w.today - due).days
        rem, _r = _reminder_view(w, inv.get("invoice_number") or "")
        sn = [x for x in w.snoozes if x.invoice_number == inv.get("invoice_number") and x.until > w.now]
        c = w.contact(inv.get("customer_id")) or {}
        out.append({
            "invoice_number": inv.get("invoice_number"), "customer_id": inv.get("customer_id"), "customer": inv.get("customer_name") or c.get("contact_name"),
            "amount": to_int(bal), "due_date": due.isoformat(), "days_late": days, "reminder": rem,
            "snoozed_until": sn[-1].until.isoformat() if sn else None,
        })
    lo_hi = {"0-7": (0, 7), "8-30": (8, 30), "31-60": (31, 60), "60+": (61, 10**6)}
    if bucket and bucket != "all" and bucket in lo_hi:
        lo, hi = lo_hi[bucket]
        out = [r for r in out if lo <= r["days_late"] <= hi]
    out.sort(key=lambda r: (-r["days_late"], -r["amount"]))
    return out


# =============================================================================== Approval card
async def approval_card(s, ap: Approval, case: Case | None = None, prop: Proposal | None = None) -> dict[str, Any]:
    case = case or await s.get(Case, ap.case_id)
    prop = prop or await s.get(Proposal, ap.proposal_id)
    a = prop.payload if prop else {}
    kind = "reminder" if a.get("type") == "send_reminder" else "invoice"
    nodes = await cs.case_nodes(s, case)
    gst = a.get("gst") or {}
    users = {}
    for x in ap.approvers or []:
        u = await s.get(User, x.get("user_id"))
        users[x.get("user_id")] = (u.name if u and u.name else x.get("email"))
    if kind == "invoice":
        li = (a.get("line_items") or [{}])[0]
        what = f"Invoice · {pl.qty(li.get('qty'))} × {li.get('item') or 'item'}"
        amount = to_int(a.get("amount"))
        tax = gst.get("tax_total")
        total = gst.get("total")
        if tax is None:
            st = await get_tenant_settings(s, ap.tenant_id)
            from .invoicing import preview_for_action

            pv = await preview_for_action(s, ap.tenant_id, a) if a.get("line_items") else gst_preview([], st, None)
            tax, total = pv["tax_total"], pv["total"]
    else:
        inv = a.get("invoice_number") or case.po_ref
        days = a.get("days_late")
        what = f"WhatsApp reminder · {inv}" + (f" · {days} days late" if days is not None else "") + " · UPI link"
        amount, tax, total = to_int(a.get("amount")), 0, to_int(a.get("amount"))
    return {
        "id": ap.id, "case_ref": case.case_number, "customer": a.get("customer_name") or case.customer, "po_ref": (a.get("reference") if kind == "invoice" else None) or case.po_ref,
        "what": what, "amount": amount, "gst": tax or 0, "total": total if total is not None else amount, "approvers_needed": ap.required_approvers,
        "approvals": [{"user": users.get(x.get("user_id")) or x.get("email"), "at": x.get("at")} for x in ap.approvers or []],
        "proofs": proofs_for_nodes(nodes), "expires_reason": _plain_expiry(ap.expires_reason) if ap.status == "expired" else None, "kind": kind,
        "status": ap.status,
    }


def _plain_expiry(reason: str | None) -> str | None:
    if not reason:
        return None
    if "edited by" in reason:
        return "Replaced by an edited version."
    if "replaced" in reason:
        return reason
    return "Expired because the evidence changed after it was drafted. A new approval was made on the new facts."


# =============================================================================== Dashboard
def _period_bounds(period: str, today: date) -> tuple[date, date, date, date]:
    """returns (start, end, prev_start, prev_end) inclusive."""
    if period == "30d":
        start = today - timedelta(days=29)
        return start, today, start - timedelta(days=30), start - timedelta(days=1)
    if period == "quarter":
        q0 = (today.month - 1) // 3 * 3 + 1
        start = date(today.year, q0, 1)
        prev_end = start - timedelta(days=1)
        pq0 = (prev_end.month - 1) // 3 * 3 + 1
        return start, today, date(prev_end.year, pq0, 1), prev_end
    start = today.replace(day=1)
    prev_end = start - timedelta(days=1)
    return start, today, prev_end.replace(day=1), prev_end


def order_ledger(w: World) -> dict[str, dict[str, Any]]:
    """Per PO reference: ordered / delivered / billed / paid (rupees, taxable for billed) + customer + date."""
    led: dict[str, dict[str, Any]] = {}

    def row(ref: str) -> dict[str, Any] | None:
        n = normalize_ref(ref)
        if not n:
            return None
        return led.setdefault(n, {"po_ref": ref, "ref_norm": n, "case_ref": None, "customer_id": None, "customer": None, "date": None,
                                  "ordered_qty": None, "rate": None, "ordered": 0.0, "delivered_qty": None, "delivered": 0.0, "billed": 0.0, "paid": 0.0,
                                  "invoices": []})

    for so in w.salesorders:
        r = row(so.get("reference_number") or so.get("salesorder_number") or "")
        if r is None:
            continue
        qty = sum(float(li.get("quantity", 0)) for li in so.get("line_items") or []) or None
        rate = float((so.get("line_items") or [{}])[0].get("rate") or 0) or None
        r.update(customer_id=so.get("customer_id"), customer=so.get("customer_name"), date=parse_date(so.get("date")), ordered_qty=qty, rate=rate, ordered=float(so.get("total") or 0))
    for cv in w.cases:
        f = cv.facts
        if not cv.case.po_ref:
            continue
        r = row(cv.case.po_ref)
        r["case_ref"] = cv.case.case_number
        r["customer_id"] = r["customer_id"] or cv.customer_id
        r["customer"] = r["customer"] or cv.customer
        r["date"] = r["date"] or parse_date(cv.case.created_at)
        if f.get("order_qty") is not None:
            r["ordered_qty"] = f["order_qty"]
        if f.get("rate") is not None:
            r["rate"] = f["rate"]
        if f.get("order_amount") is not None:
            r["ordered"] = float(f["order_amount"])
        if f.get("delivered_qty") is not None:
            r["delivered_qty"] = f["delivered_qty"]
    for sr in w.sheet_rows:
        r = row(str(sr.get("po_ref") or ""))
        if r is None or r["case_ref"]:
            continue  # a case's validator facts win over the raw sheet row
        try:
            r["delivered_qty"] = float(str(sr.get("qty_delivered")).replace(",", ""))
            if r["ordered_qty"] is None and sr.get("qty_ordered") not in (None, ""):
                r["ordered_qty"] = float(str(sr["qty_ordered"]).replace(",", ""))
        except (TypeError, ValueError):
            pass
        r["customer"] = r["customer"] or sr.get("customer")
    for r in led.values():
        if r["delivered_qty"] is not None and r["rate"]:
            r["delivered"] = float(r["delivered_qty"]) * float(r["rate"])
        if not r["ordered"] and r["ordered_qty"] and r["rate"]:
            r["ordered"] = float(r["ordered_qty"]) * float(r["rate"])
    for inv in w.invoices:
        if inv.get("status") == "void":
            continue
        n = normalize_ref(inv.get("reference_number") or "")
        if n and n in led:
            led[n]["billed"] += invoice_taxable(inv)
            led[n]["paid"] += min(float(inv.get("total") or 0), w.paid_for_invoice(inv)[0] + (float(inv.get("total") or 0) if inv.get("status") == "paid" and not w.paid_for_invoice(inv)[0] else 0))
            led[n]["invoices"].append(inv.get("invoice_number"))
    return led


def _in(d: date | None, a: date, b: date) -> bool:
    return d is not None and a <= d <= b


def recovered(w: World, a: date, b: date) -> tuple[float, int]:
    invs = [i for i in w.invoices if is_rg_invoice(i) and i.get("status") != "void" and _in(parse_date(i.get("date")), a, b)]
    return sum(float(i.get("total") or 0) for i in invs), len(invs)


async def dashboard_summary(tenant_id: str, period: str = "month", lang: str = "en") -> dict[str, Any]:
    async with session_scope() as s:
        w = await load_world(s, tenant_id)
        rows = bill_rows(w, lang=lang)
        chase = chase_rows(w)
        start, end, pstart, pend = _period_bounds(period, w.today)
        cards = await pending_cards(s, tenant_id)
    nb = [r for r in rows if r["status"] != "scheduled"]
    rec_amt, rec_n = recovered(w, start, end)
    last_amt, _ = recovered(w, pstart, pend)
    led = order_ledger(w)
    flow = {"ordered": 0.0, "delivered": 0.0, "billed": 0.0, "paid": 0.0}
    for r in led.values():
        if _in(r["date"], start, end):
            flow["ordered"] += r["ordered"]
            flow["delivered"] += r["delivered"]
    for inv in w.invoices:
        if inv.get("status") != "void" and _in(parse_date(inv.get("date")), start, end):
            flow["billed"] += invoice_taxable(inv)
    for p in w.payments:
        if _in(parse_date(p.get("date")), start, end):
            flow["paid"] += float(p.get("amount") or 0)
    inv_cards = [c for c in cards if c["kind"] == "invoice"]
    sent_states = {"sent", "read", "replied"}
    return {
        "not_billed": {"amount": sum(r["amount"] for r in nb), "count": len(nb), "oldest_days": max([r["waiting_days"] for r in nb] or [0])},
        "overdue": {"amount": sum(r["amount"] for r in chase), "count": len(chase), "reminders_sent": sum(1 for r in chase if r["reminder"]["status"] in sent_states)},
        "recovered": {"amount": to_int(rec_amt), "invoices": rec_n, "last_month": to_int(last_amt)},
        "waiting": {"amount": sum(to_int(c["total"]) for c in inv_cards), "count": len(inv_cards)},
        "flow": {k: to_int(v) for k, v in flow.items()},
        "to_bill": rows[:5], "to_chase": chase[:5], "approvals": cards[:5],
        "period": period, "as_of": w.now.isoformat(),
    }


async def pending_cards(s, tenant_id: str) -> list[dict[str, Any]]:
    aps = (await s.execute(select(Approval).where(Approval.tenant_id == tenant_id, Approval.status.in_(("pending", "partially_approved"))).order_by(Approval.created_at.desc()))).scalars().all()
    return [await approval_card(s, a) for a in aps]


# =============================================================================== Customers
def _risk(overdue_days_max: int, avg_days: float | None, terms: int, overdue_amt: float) -> tuple[str, str]:
    if overdue_days_max > 60 or (avg_days is not None and avg_days > terms + 30):
        why = f"an invoice is {overdue_days_max} days late" if overdue_days_max > 60 else f"pays in {round(avg_days)} days on {terms}-day terms"
        return "high", f"High: {why}. Rule: any invoice over 60 days late, or average payment more than 30 days past terms."
    if overdue_amt > 0 or (avg_days is not None and avg_days > terms):
        why = f"{inr(overdue_amt)} is overdue" if overdue_amt > 0 else f"pays in {round(avg_days)} days on {terms}-day terms"
        return "watch", f"Watch: {why}. Rule: anything overdue, or average payment slower than terms."
    return "good", "Good: pays within terms and nothing is overdue."


def customer_index(w: World) -> dict[str, dict[str, Any]]:
    idx: dict[str, dict[str, Any]] = {}
    for c in w.contacts:
        addr = c.get("billing_address") or {}
        idx[c["contact_id"]] = {"id": c["contact_id"], "name": c.get("contact_name"), "gstin": c.get("gst_no") or c.get("gstin"),
                                "city": c.get("city") or addr.get("city"), "contact": c}
    for cv in w.cases:
        if cv.customer_id and cv.customer_id not in idx:
            idx[cv.customer_id] = {"id": cv.customer_id, "name": cv.customer, "gstin": None, "city": None, "contact": {}}
    return idx


def customer_stats(w: World, cid: str) -> dict[str, Any]:
    invs = [i for i in w.invoices if i.get("customer_id") == cid and i.get("status") != "void"]
    outstanding = sum(w.balance(i) for i in invs)
    overdue_amt, overdue_max = 0.0, 0
    for i in invs:
        d = w.due_date(i)
        if w.balance(i) > 0 and d and d < w.today and i.get("status") != "draft":
            overdue_amt += w.balance(i)
            overdue_max = max(overdue_max, (w.today - d).days)
    paid = []
    for i in sorted(invs, key=lambda i: str(i.get("date") or ""), reverse=True):
        amt, last = w.paid_for_invoice(i)
        d0 = parse_date(i.get("date"))
        if last and d0 and (i.get("status") == "paid" or amt >= float(i.get("total") or 0) - 0.5):
            paid.append((last - d0).days)
        if len(paid) >= 6:
            break
    avg = round(sum(paid) / len(paid), 1) if paid else None
    terms = w.terms(cid)
    risk, why = _risk(overdue_max, avg, terms, overdue_amt)
    nb = sum(r["amount"] for r in (to_bill_row(w, cv) for cv in w.cases if cv.customer_id == cid) if r and r["status"] not in ("scheduled", "not_billable"))
    return {"outstanding": to_int(outstanding), "overdue": to_int(overdue_amt), "avg_days_to_pay": avg, "terms_days": terms, "risk": risk, "risk_reason": why,
            "not_billed": nb}


def customers_list(w: World) -> list[dict[str, Any]]:
    out = []
    for cid, c in customer_index(w).items():
        st = customer_stats(w, cid)
        out.append({"id": cid, "name": c["name"], "gstin": c["gstin"], "city": c["city"], "outstanding": st["outstanding"], "overdue": st["overdue"],
                    "avg_days_to_pay": st["avg_days_to_pay"], "terms_days": st["terms_days"], "risk": st["risk"], "risk_reason": st["risk_reason"]})
    out.sort(key=lambda r: (-r["overdue"], -r["outstanding"], r["name"] or ""))
    return out


def customer_detail(w: World, cid: str, extra_followups: list[dict[str, Any]]) -> dict[str, Any] | None:
    idx = customer_index(w)
    if cid not in idx:
        return None
    c = idx[cid]
    st = customer_stats(w, cid)
    contact = c["contact"]
    orders = []
    for r in order_ledger(w).values():
        if r["customer_id"] == cid or (r["customer"] and c["name"] and r["customer"].lower() == c["name"].lower()):
            orders.append({"po_ref": r["po_ref"], "case_ref": r["case_ref"], "ordered": to_int(r["ordered"]), "delivered": to_int(r["delivered"]),
                           "billed": to_int(r["billed"]), "paid": to_int(r["paid"]), "amount": to_int(r["ordered"]), "date": iso(r["date"])})
    orders.sort(key=lambda o: o["date"] or "", reverse=True)
    follow = []
    for inv in w.invoices:
        if inv.get("customer_id") != cid:
            continue
        follow.append({"at": inv.get("date"), "kind": "invoice", "text": f"Invoice {inv.get('invoice_number')} for {inr(inv.get('total') or 0)}" + (" (raised via RevenueGuard)" if is_rg_invoice(inv) else ""),
                       "status": inv.get("status")})
    for p in w.payments:
        if p.get("customer_id") == cid:
            follow.append({"at": p.get("date"), "kind": "payment", "text": f"Payment {inr(p.get('amount') or 0)} for {p.get('invoice_numbers') or p.get('reference_number')}", "status": "received"})
    for r in w.reminders:
        if r.customer_id == cid:
            follow.append({"at": r.created_at.isoformat(), "kind": "reminder", "text": f"Reminder ({r.stage} days) for {r.invoice_number}: {inr(r.amount or 0)}" + (f". {r.note}" if r.note else ""),
                           "status": r.status})
    follow += extra_followups
    follow.sort(key=lambda x: str(x["at"] or ""), reverse=True)
    phone = contact.get("mobile") or contact.get("phone")
    return {
        "customer": {"id": cid, "name": c["name"], "gstin": c["gstin"], "city": c["city"], "state_code": state_code(c["gstin"]), "contact_masked": mask_phone(phone) if phone else None,
                     "email_masked": _mask_email(contact.get("email"))},
        "stats": {k: st[k] for k in ("not_billed", "overdue", "avg_days_to_pay", "terms_days", "risk", "risk_reason")} | {"outstanding": st["outstanding"]},
        "orders": orders, "followups": follow[:50],
    }


def _mask_email(e: str | None) -> str | None:
    if not e or "@" not in e:
        return None
    u, d = e.split("@", 1)
    return f"{u[:2]}•••@{d}"


# =============================================================================== Reports
def reports_summary(w: World, a: date, b: date) -> dict[str, Any]:
    months: dict[str, float] = {}
    for inv in w.invoices:
        d = parse_date(inv.get("date"))
        if is_rg_invoice(inv) and inv.get("status") != "void" and _in(d, a, b):
            months[d.strftime("%Y-%m")] = months.get(d.strftime("%Y-%m"), 0.0) + float(inv.get("total") or 0)
    # every month in range, oldest first (zeros included)
    out_m, cur = [], date(a.year, a.month, 1)
    while cur <= b:
        k = cur.strftime("%Y-%m")
        out_m.append({"month": k, "amount": to_int(months.get(k, 0))})
        cur = date(cur.year + (cur.month // 12), cur.month % 12 + 1, 1)
    ageing = {"0-7": 0, "8-30": 0, "31-60": 0, "60+": 0}
    for r in bill_rows(w):
        d = r["waiting_days"]
        ageing["0-7" if d <= 7 else "8-30" if d <= 30 else "31-60" if d <= 60 else "60+"] += 1
    billed = sum(float(i.get("total") or 0) for i in w.invoices if i.get("status") != "void" and _in(parse_date(i.get("date")), a, b))
    collected = sum(float(p.get("amount") or 0) for p in w.payments if _in(parse_date(p.get("date")), a, b))
    return {"recovered_by_month": out_m, "unbilled_ageing": ageing,
            "collections": {"billed": to_int(billed), "collected": to_int(collected), "rate": round(collected / billed, 3) if billed else 0.0}}


CSV_COLUMNS = ["Invoice No", "Date", "Customer", "Customer GSTIN", "Place of supply", "Reference", "Taxable value", "CGST", "SGST", "IGST",
               "Round off", "Invoice total", "Paid", "Balance", "Status", "Raised via RevenueGuard"]


def export_csv(w: World, a: date, b: date) -> str:
    buf = io.StringIO()
    wr = csv.writer(buf)
    wr.writerow(CSV_COLUMNS)
    seller_state = (w.settings.get("company") or {}).get("state_code") or state_code((w.settings.get("company") or {}).get("gstin"))
    for inv in sorted(w.invoices, key=lambda i: str(i.get("date") or "")):
        d = parse_date(inv.get("date"))
        if inv.get("status") == "void" or not _in(d, a, b):
            continue
        c = w.contact(inv.get("customer_id")) or {}
        gstin = c.get("gst_no") or c.get("gstin") or ""
        taxable = invoice_taxable(inv)
        total = float(inv.get("total") or 0)
        tax = float(inv.get("tax_total") if inv.get("tax_total") is not None else max(0.0, total - taxable))
        ro = float(inv.get("adjustment") or 0)
        tax = round(tax, 2)
        pos = state_code(gstin) or seller_state
        intra = pos == seller_state
        cg = round(tax / 2, 2) if intra else 0.0
        sg = round(tax - cg, 2) if intra else 0.0
        ig = 0.0 if intra else tax
        paid = w.paid_for_invoice(inv)[0] if inv.get("status") != "paid" else total
        wr.writerow([inv.get("invoice_number"), d.isoformat() if d else "", inv.get("customer_name") or c.get("contact_name") or "", gstin, pos or "",
                     inv.get("reference_number") or "", f"{taxable:.2f}", f"{cg:.2f}", f"{sg:.2f}", f"{ig:.2f}", f"{ro:.2f}", f"{total:.2f}",
                     f"{paid:.2f}", f"{w.balance(inv):.2f}", inv.get("status") or "", "yes" if is_rg_invoice(inv) else "no"])
    return buf.getvalue()


# =============================================================================== Case summary (business view)
JOURNEY = ["received", "read", "matched", "checked", "waiting", "invoiced", "verified", "paid"]
STATE_STEP = {"INTAKE": "received", "TRIAGED": "read", "WATCHING": "matched", "EVIDENCE_READY": "checked", "VALIDATED": "checked",
              "INVESTIGATING": "checked", "PROPOSED": "checked", "AWAITING_APPROVAL": "waiting", "EXECUTING": "invoiced", "VERIFYING": "verified"}
CAPTIONS = {
    "received": "Message received", "read": "Read the message and documents", "matched": "Matched to the order", "checked": "Checked the numbers",
    "waiting": "Waiting for approval", "invoiced": "Invoice created", "verified": "Checked in Zoho", "paid": "Payment received",
}
TOOL_CAPTIONS = {
    "gmail_search": "Looked in Gmail for the PO", "whatsapp_search": "Checked WhatsApp for delivery updates", "sheets_read_delivery": "Read the delivery sheet",
    "drive_read_doc": "Read the billing rules in Drive", "zoho_get_salesorders": "Checked the sales order in Zoho", "zoho_get_invoices": "Checked Zoho for an invoice",
    "zoho_get_payments": "Checked Zoho for payments", "bank_get_payments": "Checked the bank feed for payments",
    "search_alt_ids": "Checked if it was billed under another reference", "search_credit_notes": "Checked credit notes",
    "compute_billable": "Worked out the exact amount to bill", "get_billing_rules": "Checked the customer's billing rule",
    "read_case_timeline": "Read every message of the order in time order", "read_chat_memory": "Checked what this chat said before",
    "search_cases": "Looked for other orders this message could be about", "write_chat_memory": "Updated the chat's notes",
    "propose_timeline": "Checked its reading against the messages",
}


def _problem(case: Case) -> dict[str, str] | None:
    if case.state == "PAUSED":
        conn = (case.paused_reason or "").split(" ")[0].replace("connector:", "") or "a connection"
        name = {"zoho": "Zoho", "gmail": "Gmail", "sheets": "the delivery sheet", "whatsapp": "WhatsApp", "harness": "the checking service", "kill_switch": "the kill switch"}.get(conn, conn)
        return {"reason": f"{name} is not reachable right now.", "next": "We will retry automatically. Nothing was billed twice."}
    if case.state == "ESCALATED":
        r = (case.escalation_reason or "").split(":")[0]
        text = {"conflict": "The delivery numbers do not agree.", "duplicate_invoices": "More than one invoice exists for this order.",
                "customer_unresolved": "We could not match the customer in Zoho.", "approval_rejected": "The approval was rejected.",
                "verification_failed": "The invoice in Zoho does not match what was approved.", "budget": "This case needed more checking than allowed.",
                "edited_after_billing": "A message was changed or deleted after the invoice was made. The invoice was not changed.",
                "timeline_check": "The AI's reading of the chat did not pass our checks."}.get(r, "This case needs a person to look at it.")
        return {"reason": text, "next": "Please check the proof and correct the fact, or resolve it under Advanced."}
    if case.state == "BLOCKED":
        return {"reason": "We stopped this for safety (it would have billed twice or broken a rule).", "next": "Check the existing invoice in Zoho."}
    return None


async def _case_chats(s, case: Case):
    from . import chat_memory

    return await chat_memory.chats_for_case(s, case.tenant_id, case)


def _mem_view(m) -> dict[str, Any]:
    """Plain view of a chat's memory for the case page: what the chat said, newest last (+ the timeline agent's notes)."""
    st = m.state or {}
    return {"chat_key": m.chat_id, "label": m.chat_name or m.chat_id, "active_po": st.get("active_po"), "open_questions": st.get("open_questions") or [],
            "pending": st.get("pending") or [], "summary": st.get("summary") or "", "cases": [x.get("case_number") for x in (m.cases or []) if x.get("case_number")],
            "chat": m.chat_name or m.chat_id, "customer": m.customer, "pos": [x.get("po") for x in (m.cases or []) if x.get("po")],
            "challans": [{"no": x["no"], "po": x.get("po"), "qty": x.get("qty")} for x in (m.challans or [])][-10:],
            "said": [{"at": e["ts"], "po": e.get("po"), "text": e["said"], "by": e.get("by")} for e in (m.events or [])][-10:]}


async def case_summary(s, case: Case, lang: str = "en") -> dict[str, Any]:
    w = await load_world(s, case.tenant_id, with_cases=False)
    f = await cs.compute_facts(s, case)
    fj = f.to_json()
    nodes = await cs.case_nodes(s, case)
    node_by_id = {n.id: n for n in nodes}
    aps = (await s.execute(select(Approval).where(Approval.case_id == case.id).order_by(Approval.created_at))).scalars().all()
    acts = (await s.execute(select(Action).where(Action.case_id == case.id).order_by(Action.created_at))).scalars().all()
    ver = (await s.execute(select(Verification).where(Verification.case_id == case.id).order_by(Verification.created_at.desc()).limit(1))).scalar_one_or_none()
    cps = (await s.execute(select(CaseCheckpoint).where(CaseCheckpoint.case_id == case.id).order_by(CaseCheckpoint.seq))).scalars().all()
    props = (await s.execute(select(Proposal).where(Proposal.case_id == case.id).order_by(Proposal.version))).scalars().all()
    mark = (await s.execute(select(NotBillableMark).where(NotBillableMark.case_id == case.id, NotBillableMark.active.is_(True)))).scalars().first()
    succeeded = [a for a in acts if a.status == "succeeded" and a.type == "create_invoice"]
    billed_qty = 0.0
    inv_no = None
    for d in f.duplicates:
        src = next((i for i in f.invoices if i.get("invoice_id") == d["invoice_id"]), {})
        billed_qty += float(src.get("qty") or 0)
        inv_no = inv_no or d.get("invoice_number")
    if succeeded:
        inv_no = (succeeded[-1].response or {}).get("invoice_number") or inv_no
    cust_id = f.customer_id or ((w.contact_by_name(f.customer_name or case.customer) or {}).get("contact_id"))
    cv = CaseView(case, fj, nodes, cust_id, f.customer_name or case.customer, billed_qty, bool(succeeded), inv_no, mark, list(aps))
    pf = plain_facts(w, cv)
    if case.exception_type == COLLECTION_TYPE and props:
        pa = props[-1].payload
        pf.update(invoice_number=pa.get("invoice_number"), days_late=pa.get("days_late"), amount=pa.get("amount"))
    if succeeded:
        pf["amount"] = (succeeded[-1].response or {}).get("total") or succeeded[-1].request.get("amount")
    exp = pl.explain(pf, lang, case.exception_type)

    # ---- journey
    problem = _problem(case)
    base_state = case.paused_from if case.state == "PAUSED" and case.paused_from else case.state
    if case.state in ("ESCALATED", "BLOCKED"):
        current = "checked"
    elif case.state == "CLOSED":
        paid = f.paid_amount > 0 and succeeded
        current = "paid" if paid else ("verified" if (ver and ver.status == "pass") else "checked")
    else:
        current = STATE_STEP.get(base_state, "checked")
    first_at: dict[str, str] = {}
    for cp in cps:
        step = STATE_STEP.get(cp.state) or ("verified" if cp.state == "CLOSED" and ver else None)
        if step and step not in first_at:
            first_at[step] = cp.created_at.isoformat()
    if nodes:
        first_at.setdefault("received", nodes[0].created_at.isoformat())
    ci = JOURNEY.index(current)
    steps = []
    for i, k in enumerate(JOURNEY):
        if i < ci:
            st = "done"
        elif i == ci:
            st = "problem" if problem else ("waiting" if k == "waiting" else ("done" if case.state == "CLOSED" and k in ("verified", "paid") else "current"))
        else:
            st = "todo"
        cap = CAPTIONS[k]
        if k == "waiting" and st == "waiting":
            pend = next((a for a in reversed(aps) if a.status in ("pending", "partially_approved")), None)
            if pend:
                cap = f"Waiting for {pend.required_approvers - len(pend.approvers or [])} of {pend.required_approvers} approvers"
        if k == "invoiced" and inv_no and st in ("done", "current"):
            cap = f"Invoice {inv_no} created"
        steps.append({"key": k, "status": st, "at": first_at.get(k) if st != "todo" else None, "caption": cap})
    journey = {"current": current, "problem": problem, "steps": steps}

    # ---- documents
    tl = {t["stage"]: t for t in (await _timeline(f))}
    docs = []
    for stage in ("order", "delivery", "invoice", "payment"):
        t = tl.get(stage) or {"status": "missing", "evidence_node_ids": []}
        ids = [i for i in t["evidence_node_ids"] if i in node_by_id] or (f.stage_nodes.get(stage) or [])
        n0 = node_by_id.get(ids[0] if stage == "order" else ids[-1]) if ids else None
        p = proof_for_node(n0) if n0 else None
        key = None
        if stage == "order" and f.order_qty is not None:
            key = f"{case.po_ref} · {pl.qty(f.order_qty)} × {f.item or 'item'}"
        elif stage == "delivery" and f.delivered_qty is not None:
            key = f"{pl.qty(f.delivered_qty)} delivered"
        elif stage == "invoice" and inv_no:
            key = inv_no
        elif stage == "payment" and f.paid_amount:
            key = inr(f.paid_amount)
        status = t["status"]
        if stage == "invoice" and succeeded and status == "missing":
            status = "found"
        docs.append({"stage": stage, "status": status, "date": iso(n0.ts) if n0 else None, "source": p["label"] if p else None, "key_number": key})

    # ---- facts with sources
    def src(nid):
        n = node_by_id.get(nid)
        return proof_for_node(n) if n else None

    facts = []
    if case.po_ref:
        pc = next((n for n in reversed(nodes) if (n.fields or {}).get("po_ref_from") and (n.fields or {}).get("is_correction")), None)
        facts.append({"id": "po_ref", "label": "PO number", "value": case.po_ref, "source": proof_for_node(pc) if pc else {"kind": "manual", "label": "Case record", "node_id": None},
                      "changed_from": (pc.fields or {}).get("po_ref_from") if pc else None, "at": iso(pc.ts) if pc else None})
    order_nodes = f.stage_nodes.get("order") or []
    if f.order_qty is not None:
        facts.append({"id": "order_qty", "label": "Ordered", "value": f"{pl.qty(f.order_qty)} × {f.item or 'item'}", "source": src(order_nodes[0]) if order_nodes else None,
                      "changed_from": None, "at": iso(node_by_id[order_nodes[0]].ts) if order_nodes and order_nodes[0] in node_by_id else None})
    if f.rate is not None:
        facts.append({"id": "rate", "label": "Rate", "value": inr(f.rate), "source": src(order_nodes[0]) if order_nodes else None, "changed_from": None, "at": None})
    if f.delivered_qty is not None:
        dsrc = [d for d in f.delivery_sources]
        latest = max(dsrc, key=lambda d: d["ts"]) if dsrc else None
        corr = next((d for d in sorted(dsrc, key=lambda d: d["ts"]) if d.get("correction")), None)
        changed = None
        if corr:
            older = [n for n in nodes if (n.fields or {}).get("qty_delivered") is not None and not n.quarantined and n.id != corr["node_id"] and (n.ts or n.created_at) <= datetime.fromisoformat(corr["ts"])]
            prev_vals = [float(n.fields["qty_delivered"]) for n in older if float(n.fields["qty_delivered"]) != float(f.delivered_qty)]
            changed = pl.qty(prev_vals[-1]) if prev_vals else None
        use = corr or latest
        ch = next((d.get("challans") for d in dsrc if d.get("challans")), None)
        facts.append({"id": "delivered_qty", "label": "Delivered", "value": pl.qty(f.delivered_qty), "source": src(use["node_id"]) if use else None,
                      "changed_from": changed, "at": use["ts"] if use else None,
                      "breakdown": (" + ".join(f"challan {k}: {pl.qty(v)}" for k, v in ch.items()) if ch and len(ch) > 1 else None)})
    if f.billable:
        facts.append({"id": "billable", "label": "To bill (before GST)", "value": inr(f.billable.get("amount_when_due") or 0), "source": {"kind": "manual", "label": "Calculated", "node_id": None},
                      "changed_from": None, "at": None})
    if f.customer_name or case.customer:
        cn = next((n for n in nodes if (n.fields or {}).get("customer") and not n.quarantined), None)
        facts.append({"id": "customer", "label": "Customer", "value": f.customer_name or case.customer, "source": proof_for_node(cn) if cn else None, "changed_from": None, "at": None})

    # ---- callouts
    callouts = []
    for a in aps:
        if a.status == "expired" and a.expires_reason and "edited" not in a.expires_reason:
            corr_fact = next((x for x in facts if x["id"] == "delivered_qty" and x["changed_from"]), None)
            why = f" because the delivery changed from {corr_fact['changed_from']} to {corr_fact['value']}" if corr_fact else " because the evidence changed"
            callouts.append({"kind": "approval_expired", "text": f"The {inr(a.amount or 0)} approval expired{why}. A new one was made on the new facts."})
    for n in nodes:
        if n.quarantined:
            snippet = (n.excerpt or n.title or "")[:60]
            callouts.append({"kind": "quarantined", "text": f"We ignored a suspicious {('email' if n.source == 'gmail' else 'message')} that tried to give instructions (\"{snippet}\"). It was not used for any number."})
    for n in nodes:
        if (n.fields or {}).get("is_correction") and not n.quarantined:
            who = "you" if n.source == "manual" else (n.title.split(" from ")[-1] if " from " in (n.title or "") else "the team")
            callouts.append({"kind": "corrected", "text": f"Corrected by {who} on {pl.short_date(n.ts)}: {n.excerpt[:80] or 'new value'}."})

    # ---- preview / approval / how found
    active = next((p for p in reversed(props) if p.status == "active"), None)
    preview = None
    if active and active.payload.get("type") == "create_invoice" and active.payload.get("line_items"):
        from .invoicing import preview_for_action

        preview = await preview_for_action(s, case.tenant_id, active.payload)
    elif f.billable and float(f.billable.get("amount_when_due") or 0) > 0 and f.billable.get("billable_qty"):
        preview = _gst_for(w, cv, [{"item": f.item or "Item", "qty": f.billable["billable_qty"], "rate": f.billable.get("rate")}])
    pend = next((a for a in reversed(aps) if a.status in ("pending", "partially_approved")), None)
    card = await approval_card(s, pend, case) if pend else None
    runs = (await s.execute(select(AgentRun).where(AgentRun.case_id == case.id))).scalars().all()
    calls = (await s.execute(select(ToolCall).where(ToolCall.case_id == case.id).order_by(ToolCall.created_at))).scalars().all()
    end = next((cp.created_at for cp in cps if cp.state in ("AWAITING_APPROVAL", "CLOSED", "ESCALATED")), None) or (cps[-1].created_at if cps else case.created_at)
    extra = []
    for t in calls:
        if t.agent == "investigation" and t.allowed and t.tool in TOOL_CAPTIONS and TOOL_CAPTIONS[t.tool] not in extra:
            extra.append(TOOL_CAPTIONS[t.tool])
    conflicts = bool(f.conflicts)
    complete = f.order_qty is not None and f.delivered_qty is not None and f.rate is not None
    # ---- what happened (timeline agent, CONTRACT_V3 §4)
    from . import timeline as tlm

    tl_rec = await tlm.get_record(s, case)
    tl_check = await tlm.needs_check_flag(s, case)
    tl_roles = tlm.roles_by_node(tl_rec)
    timeline_rows = []
    for row in await tlm.case_timeline(s, case):
        ev = tl_roles.get(row["node_id"]) or {}
        timeline_rows.append({k: row[k] for k in ("node_id", "at", "kind", "source_label", "text", "status", "versions", "duplicate_of", "read_by",
                                                  "language", "challan_number", "qty")} | {"role": ev.get("role"), "why": ev.get("why")})
    tl_conflict = next((c for c in f.conflicts if c.get("source") == "timeline_check"), None)
    if tl_check:
        conf, reason = "needs_check", f"{tl_check.get('reason')}. The invoice was not changed; please check."
    elif tl_conflict:
        conf, reason = "needs_check", f"Needs a check: {tl_conflict.get('reason')}"
    elif conflicts:
        conf, reason = "needs_check", "The sources disagree on the delivered quantity."
    elif problem:
        conf, reason = "needs_check", problem["reason"]
    elif not complete and case.exception_type != COLLECTION_TYPE:
        conf, reason = "needs_check", "Some of the order or delivery details are still missing."
    else:
        srcs = sorted({SRC_NAME.get(d["source"], d["source"]) for d in f.delivery_sources})
        reason = (f"Order and delivery agree across {', '.join(srcs)}" if srcs else "The records agree") + ("; a later correction was applied." if any(d.get("correction") for d in f.delivery_sources) else ".")
        conf = "high"
    return {
        "case_ref": case.case_number, "po_ref": case.po_ref, "customer": cv.customer, "customer_id": cust_id, "headline": exp["headline"], "recommendation": exp["recommendation"],
        "confidence": conf, "confidence_reason": reason, "journey": journey, "documents": docs, "facts": facts, "callouts": callouts, "chat_memory": [_mem_view(m) for m in await _case_chats(s, case)],
        "invoice_preview": preview, "approval": card, "timeline": timeline_rows, "timeline_decision": tlm.summary_view(tl_rec),
        "how_found": {"agents": len({r.agent for r in runs}), "checks": len(calls), "seconds": _run_seconds(runs, end), "extra_searches": extra},
        "state": case.state, "lang": lang,
    }


def _run_seconds(runs, end) -> int:
    if not runs:
        return 0
    start = min(r.started_at for r in runs)
    stop = max((r.finished_at or r.started_at) for r in runs)
    return max(0, int((stop - start).total_seconds()))


SRC_NAME = {"whatsapp": "WhatsApp", "sheets": "the sheet", "gmail": "email", "media": "the challan", "manual": "your correction"}


async def _timeline(f) -> list[dict[str, Any]]:
    from .validator import build_timeline

    return build_timeline(f)


# =============================================================================== Unlinked suggestions
def fuzzy_customer(text: str, names: list[str]) -> tuple[str | None, str | None, float]:
    """Find a customer-ish phrase in `text`. Returns (phrase as typed, canonical name, score)."""
    words = re.findall(r"[A-Za-z][A-Za-z.&]*", text or "")
    best = (None, None, 0.0)
    for nm in names:
        if not nm:
            continue
        core = re.sub(r"\b(pvt|ltd|llp|private|limited|co|the)\b\.?", "", nm.lower()).strip()
        core_words = core.split()
        for size in range(1, min(3, len(words)) + 1):
            for i in range(0, len(words) - size + 1):
                phrase = " ".join(words[i:i + size])
                target = " ".join(core_words[:max(1, size)])
                r = difflib.SequenceMatcher(None, phrase.lower(), target).ratio()
                if size == 1 and len(phrase) < 4:
                    continue
                if r >= 0.7 and size > 1 and len(core_words) >= size:
                    r += 0.1 * (size - 1)  # prefer the whole name as typed ("Exmpl Cust") over one word
                if r > best[2]:
                    best = (phrase, nm, r)
    return best if best[2] >= 0.62 else (None, None, best[2])


def suggestions_for(text: str, extracted: dict[str, Any], w: World) -> list[dict[str, Any]]:
    out = []
    po = extracted.get("po_ref")
    nums = set(re.findall(r"\b(\d{2,6})\b", text or ""))
    if po:
        nums.add(re.sub(r"\D", "", normalize_ref(po) or ""))
    cust_canon = extracted.get("customer_canonical")
    for cv in w.cases:
        c = cv.case
        if c.state == "CLOSED" or not c.po_ref:
            continue
        score = 0.0
        digits = re.sub(r"\D", "", c.po_ref_norm or "")
        if po and refs_match(po, c.po_ref):
            score += 0.7
        elif digits and digits in nums:
            score += 0.55
        if cust_canon and cv.customer and cust_canon.lower() == cv.customer.lower():
            score += 0.35
        elif cv.customer and extracted.get("customer") and difflib.SequenceMatcher(None, extracted["customer"].lower(), cv.customer.lower()).ratio() > 0.6:
            score += 0.25
        q = extracted.get("qty")
        if q is not None and cv.facts.get("order_qty") and float(q) <= float(cv.facts["order_qty"]):
            score += 0.05
        if score >= 0.25:
            out.append({"case_ref": c.case_number, "po_ref": c.po_ref, "customer": cv.customer, "confidence": round(min(score, 0.99), 2)})
    out.sort(key=lambda x: -x["confidence"])
    return out[:3]


async def connector_health(s, tenant_id: str) -> dict[str, dict[str, Any]]:
    from .breaker import all_breakers
    from .flags import chaos_on
    from .connectors.base import CONNECTOR_NAMES

    br = all_breakers()
    out = {}
    for n in CONNECTOR_NAMES:
        c = await get_connector(s, tenant_id, n)
        err = (c.error or "").lower()
        state = None
        for k, v in br.items():
            if k.endswith(f":{n}") or k == n:
                state = (v or {}).get("state") if isinstance(v, dict) else v
        if c.status == "revoked" or "token" in err or "revoked" in err or "invalid_grant" in err:
            h, plain = "relogin", "The login has expired. Please reconnect."
        elif c.status != "connected":
            h, plain = "down", "Not connected yet."
        elif (n == "zoho" and await chaos_on(s, tenant_id, "zoho_down")) or state == "open":
            h, plain = "down", f"{n.title()} is not responding. We will retry automatically."
        elif state == "half_open" or err:
            h, plain = "slow", f"{n.title()} had a problem recently: {c.error[:120]}" if c.error else f"{n.title()} is slow right now."
        else:
            h, plain = "ok", None
        out[n] = {"health": h, "last_sync": iso(c.last_sync_at or c.authorized_at), "error_plain": plain}
    return out
