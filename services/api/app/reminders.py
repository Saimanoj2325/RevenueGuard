"""Payment reminder drafts (7 / 15 / 30 days past due, polite -> firm, UPI pay link).

A draft becomes a NORMAL customer-message approval on a collection case (same Proposal + Approval + Action Gateway
path as invoices: role check, payload hash, idempotency key, read-back). Nothing is ever sent from here.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any
from urllib.parse import quote

from sqlalchemy import select

from . import case_service as cs
from . import plain_language as pl
from .audit import append_audit
from .business import COLLECTION_TYPE, approval_card, load_world, to_int
from .db import session_scope, utcnow
from .gst import inr
from .models import Approval, Case, CaseCheckpoint, Reminder
from .validator import normalize_ref


class ReminderError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


def upi_link(vpa: str, name: str, amount: Any, invoice: str) -> str:
    amt = Decimal(str(amount)).quantize(Decimal("0.01"))
    am = str(int(amt)) if amt == amt.to_integral_value() else str(amt)
    return f"upi://pay?pa={quote(vpa, safe='@.')}&pn={quote(name)}&am={am}&tn={quote(invoice)}"


async def _collection_case(s, tenant_id: str, invoice_number: str, customer: str | None, actor: str, case_number: str | None) -> tuple[Case, bool]:
    c = (await s.execute(select(Case).where(Case.tenant_id == tenant_id, Case.exception_type == COLLECTION_TYPE, Case.po_ref == invoice_number,
                                            Case.state != "CLOSED").order_by(Case.created_at.desc()))).scalars().first()
    if c is not None and c.state == "AWAITING_APPROVAL":
        return c, False
    number = case_number or await cs.next_case_number(s, tenant_id)
    c = Case(tenant_id=tenant_id, case_number=number, state="INTAKE", exception_type=COLLECTION_TYPE, severity="medium", po_ref=invoice_number,
             po_ref_norm=normalize_ref(invoice_number), customer=customer, title=f"Payment reminder · {invoice_number} · {customer or ''}"[:300])
    s.add(c)
    await s.flush()
    s.add(CaseCheckpoint(tenant_id=tenant_id, case_id=c.id, seq=1, from_state=None, state="INTAKE", reason="collections: invoice past due", payload={"invoice": invoice_number},
                         evidence_version=0, correlation_id=c.correlation_id))
    await append_audit(s, tenant_id, "case.opened", actor, {"case_number": number, "invoice": invoice_number, "kind": "collection"}, c.id, c.correlation_id)
    return c, True


async def draft_reminder(tenant_id: str, invoice_number: str, stage: int | None, actor: str, lang: str | None = None,
                         case_number: str | None = None) -> dict[str, Any]:
    from .gateway import required_approvers
    from .orchestrator.engine import _new_proposal
    from .validator import check_proposal

    async with session_scope() as s:
        w = await load_world(s, tenant_id, with_cases=False)
        inv = next((i for i in w.invoices if (i.get("invoice_number") or "").upper() == invoice_number.upper()), None)
        if inv is None:
            raise ReminderError(404, f"invoice {invoice_number} not found in your accounting data")
        bal = w.balance(inv)
        if bal <= 0:
            raise ReminderError(409, f"{invoice_number} is already paid")
        due = w.due_date(inv)
        days = max(0, (w.today - due).days) if due else 0
        ladder = sorted(int(x) for x in (w.settings.get("reminder_ladder") or [7, 15, 30]))
        if stage is None:
            stage = max([x for x in ladder if x <= days] or [ladder[0]])
        company = w.settings.get("company") or {}
        vpa = company.get("upi_vpa")
        if not vpa:
            raise ReminderError(409, "Add your UPI ID (VPA) in Settings before drafting reminders")
        lang = lang or w.settings.get("language") or "en"
        contact = w.contact(inv.get("customer_id")) or {}
        cname = inv.get("customer_name") or contact.get("contact_name") or "Customer"
        link = upi_link(vpa, company.get("name") or "", to_int(bal), inv["invoice_number"])
        msg = pl.reminder_text(stage, lang, customer=cname, invoice=inv["invoice_number"], amount=inr(to_int(bal)), due=pl.short_date(due.isoformat() if due else None),
                               days=days, upi=link, company=company.get("name") or "")
        case, created = await _collection_case(s, tenant_id, inv["invoice_number"], cname, actor, case_number)
        if created:
            node, _ = await cs.add_evidence(s, case, tenant_id, kind="invoice", source="zoho", source_id=f"inv:{inv.get('invoice_id')}",
                                            title=f"Zoho invoice {inv['invoice_number']} · due {due.isoformat() if due else '?'}",
                                            excerpt=f"total {inv.get('total')} balance {bal} status {inv.get('status')}",
                                            fields={"invoice_id": inv.get("invoice_id"), "invoice_number": inv["invoice_number"], "customer_id": inv.get("customer_id"),
                                                    "customer": cname, "total": inv.get("total"), "balance": bal, "due_date": due.isoformat() if due else None},
                                            actor=actor)
            for to, why in (("TRIAGED", "collections: invoice is past due"), ("WATCHING", "collections: checking payments"),
                            ("EVIDENCE_READY", "invoice and balance read from accounting"), ("VALIDATED", f"balance {bal} unpaid, {days} days late"),
                            ("PROPOSED", f"reminder stage {stage} drafted")):
                await cs.transition(s, case, to, why, actor=actor)
            node_id = node.id
        else:
            old = (await s.execute(select(Approval).where(Approval.case_id == case.id, Approval.status.in_(("pending", "partially_approved"))))).scalars().all()
            for a in old:
                a.status, a.expires_reason, a.decided_at = "expired", "replaced by a newer reminder draft", utcnow()
                await append_audit(s, tenant_id, "approval.expired", actor, {"approval_id": a.id, "reason": a.expires_reason}, case.id, case.correlation_id)
            for r in (await s.execute(select(Reminder).where(Reminder.tenant_id == tenant_id, Reminder.invoice_number == inv["invoice_number"], Reminder.status == "draft"))).scalars().all():
                r.status = "expired"
            nodes = await cs.case_nodes(s, case)
            node_id = next((n.id for n in nodes if n.kind == "invoice"), nodes[0].id if nodes else None)
        action = {"type": "send_reminder", "customer_id": inv.get("customer_id"), "customer_name": cname, "reference": inv["invoice_number"], "line_items": [],
                  "amount": float(to_int(bal)), "message": msg, "channel": "whatsapp", "invoice_number": inv["invoice_number"], "days_late": days, "stage": stage,
                  "upi_link": link, "lang": lang}
        claims = [{"text": f"{inv['invoice_number']} has {inr(to_int(bal))} unpaid, {days} days past due", "evidence_node_ids": [node_id]}]
        chk = check_proposal({"action": action, "claims": claims}, {"evidence_node_ids": [node_id], "quarantined_node_ids": []})
        if not chk["ok"]:
            raise ReminderError(422, "; ".join(chk["errors"]))
        prop = await _new_proposal(s, case, action, claims, [], "low", created_by=f"user:{actor}", validation={"check": chk, "kind": "reminder"})
        ap = Approval(tenant_id=tenant_id, case_id=case.id, proposal_id=prop.id, payload_hash=prop.payload_hash, evidence_version=case.evidence_version,
                      amount=action["amount"], required_approvers=required_approvers(action["amount"]), status="pending")
        s.add(ap)
        await s.flush()
        if case.state == "PROPOSED":
            await cs.transition(s, case, "AWAITING_APPROVAL", "customer message needs approval", {"approval_id": ap.id}, actor=actor)
        s.add(Reminder(tenant_id=tenant_id, invoice_number=inv["invoice_number"], customer_id=inv.get("customer_id"), stage=stage, status="draft", amount=action["amount"],
                       message=msg, upi_link=link, case_id=case.id, approval_id=ap.id, created_by=actor))
        await append_audit(s, tenant_id, "reminder.drafted", actor, {"invoice": inv["invoice_number"], "stage": stage, "approval_id": ap.id, "payload_hash": prop.payload_hash},
                           case.id, case.correlation_id)
        await append_audit(s, tenant_id, "approval.requested", actor, {"approval_id": ap.id, "proposal_id": prop.id, "amount": action["amount"], "kind": "reminder"}, case.id, case.correlation_id)
        cs.queue_event(s, tenant_id, {"type": "approval.updated", "approval": cs.approval_json(ap)})
        card = await approval_card(s, ap, case, prop)
        card["message"] = msg
        card["upi_link"] = link
        case_id = case.id
    from .notify import approval_created

    await approval_created(case_id)
    return card
