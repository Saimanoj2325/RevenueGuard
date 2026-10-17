"""Action Gateway: the ONLY path that writes to Zoho / WhatsApp / Gmail.

Checks, in order: kill switch -> approval state + roles + distinct approvers (2 above ₹1L) -> evidence version
-> payload hash -> idempotency key (unique) -> target pre-check (existing invoice) -> circuit-broken write ->
retry-after-read on timeout. Every outcome is audited."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from . import case_service as cs
from .audit import append_audit
from .breaker import CircuitOpenError, get_breaker
from .config import get_settings
from .connectors.base import ConnectorError, ConnectorTimeout, ConnectorUnavailable
from .connectors.registry import adapter
from .db import session_scope, utcnow
from .flags import KILL_SWITCH, get_flag
from .models import Action, Approval, Case, Proposal, User
from .observability import get_logger
from .security import APPROVER_ROLES, payload_hash, sha256_text
from .validator import refs_match

log = get_logger("gateway")
_local_locks: dict[str, asyncio.Lock] = {}


@dataclass
class GatewayResult:
    status: str  # succeeded | duplicate | blocked | paused | stale
    action_id: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)


def required_approvers(amount: Any) -> int:
    return 2 if Decimal(str(amount or 0)) > Decimal(get_settings().approval_two_person_threshold_inr) else 1


def idempotency_key(tenant_id: str, case_id: str, proposal_id: str, p_hash: str) -> str:
    return sha256_text(f"{tenant_id}:{case_id}:{proposal_id}:{p_hash}")


def _zoho_payload(action: dict[str, Any], case: Case, key: str) -> dict[str, Any]:
    gst = action.get("gst") or {}
    glines = gst.get("lines") or []
    items = []
    for i, li in enumerate(action.get("line_items", [])):
        row = {"name": li["item"], "quantity": li["qty"], "rate": li["rate"]}
        if i < len(glines):  # approved GST lines (hash-bound) travel with the write
            row["hsn_or_sac"] = glines[i].get("hsn") or None
            row["tax_percentage"] = glines[i].get("gst_rate")
        items.append(row)
    out = {
        "customer_id": action["customer_id"],
        "reference_number": action.get("reference") or case.po_ref,
        "line_items": items,
        "notes": f"Raised via RevenueGuard case {case.case_number} after approval.",
    }
    if gst:
        out["place_of_supply"] = (gst.get("place_of_supply") or "")[:2] or None
        out["gst_total_expected"] = gst.get("total")
    return out


def _invoice_has_key(inv: dict[str, Any], key: str) -> bool:
    for cf in inv.get("custom_fields") or []:
        if cf.get("value") == key:
            return True
    return key[:16] in (inv.get("notes") or "")


async def _audit(case: Case, event: str, actor: str, data: dict[str, Any]) -> None:
    async with session_scope() as s:
        await append_audit(s, case.tenant_id, event, actor, data, case.id, case.correlation_id)


async def execute(approval_id: str, actor: str = "gateway") -> GatewayResult:
    # ---------------------------------------------------------------- policy checks + idempotent claim
    async with session_scope() as s:
        ap = await s.get(Approval, approval_id)
        case = await s.get(Case, ap.case_id)
        prop = await s.get(Proposal, ap.proposal_id)
        tenant = case.tenant_id
        if await get_flag(s, tenant, KILL_SWITCH, False):
            await append_audit(s, tenant, "gateway.blocked", actor, {"reason": "kill_switch", "approval_id": ap.id}, case.id, case.correlation_id)
            cs.guardrail_event(s, tenant, case.id, "paused", {"reason": "kill switch enabled: all gateway writes blocked"})
            return GatewayResult("paused", detail={"reason": "kill_switch", "connector": "kill_switch"})
        if ap.status != "approved":
            await append_audit(s, tenant, "gateway.blocked", actor, {"reason": f"approval status {ap.status}"}, case.id, case.correlation_id)
            return GatewayResult("blocked" if ap.status != "expired" else "stale", detail={"reason": f"approval {ap.status}"})
        approver_ids = {a["user_id"] for a in ap.approvers or []}
        users = (await s.execute(select(User).where(User.id.in_(approver_ids or {"-"}), User.tenant_id == tenant))).scalars().all() if approver_ids else []
        valid = {u.id for u in users if u.role in APPROVER_ROLES and u.active}
        if len(valid) < max(ap.required_approvers, required_approvers(prop.payload.get("amount"))):
            await append_audit(s, tenant, "gateway.blocked", actor, {"reason": "insufficient distinct authorised approvers", "valid": len(valid), "required": ap.required_approvers}, case.id, case.correlation_id)
            cs.guardrail_event(s, tenant, case.id, "role_block", {"reason": "insufficient approvers at execution time"})
            return GatewayResult("blocked", detail={"reason": "insufficient approvers"})
        if ap.evidence_version != case.evidence_version:
            await cs.expire_approvals_on_evidence_change(s, case, "evidence changed before execution")
            return GatewayResult("stale", detail={"reason": "evidence_version changed"})
        actual_hash = payload_hash(prop.payload)
        if not (actual_hash == prop.payload_hash == ap.payload_hash):
            await append_audit(s, tenant, "gateway.blocked", actor, {"reason": "payload hash mismatch", "approved": ap.payload_hash, "actual": actual_hash}, case.id, case.correlation_id)
            cs.guardrail_event(s, tenant, case.id, "role_block", {"reason": "payload altered after approval"})
            return GatewayResult("blocked", detail={"reason": "payload_hash_mismatch"})
        key = idempotency_key(tenant, case.id, prop.id, ap.payload_hash)
        existing = (await s.execute(select(Action).where(Action.idempotency_key == key))).scalar_one_or_none()
        if existing and existing.status == "succeeded":
            await append_audit(s, tenant, "gateway.duplicate_blocked", actor, {"idempotency_key": key, "action_id": existing.id}, case.id, case.correlation_id)
            cs.guardrail_event(s, tenant, case.id, "duplicate_block", {"idempotency_key": key[:16], "action_id": existing.id, "target_id": existing.target_id})
            return GatewayResult("duplicate", existing.id, {"target_id": existing.target_id})
        action_payload = dict(prop.payload)
        a_type = action_payload.get("type")
        target = "zoho" if a_type == "create_invoice" else (action_payload.get("channel") or "whatsapp")
    if existing is None:
        try:
            async with session_scope() as s:
                act = Action(tenant_id=tenant, case_id=case.id, approval_id=approval_id, proposal_id=prop.id, type=a_type, idempotency_key=key,
                             status="pending", target_system=target, request=action_payload, executed_by=actor)
                s.add(act)
                await s.flush()
                await append_audit(s, tenant, "gateway.claimed", actor, {"action_id": act.id, "idempotency_key": key, "type": a_type}, case.id, case.correlation_id)
                action_id = act.id
        except IntegrityError:
            async with session_scope() as s:
                cs.guardrail_event(s, tenant, case.id, "duplicate_block", {"idempotency_key": key[:16], "reason": "concurrent execution of the same approved action"})
                await append_audit(s, tenant, "gateway.duplicate_blocked", actor, {"idempotency_key": key, "reason": "concurrent claim"}, case.id, case.correlation_id)
            return GatewayResult("duplicate", detail={"reason": "concurrent claim"})
    else:
        action_id = existing.id  # pending/unknown/failed -> retry path (read first)

    # ---------------------------------------------------------------- perform the write
    lock = _local_locks.setdefault(key, asyncio.Lock())  # SQLite has no row locks; Postgres uses FOR UPDATE below
    async with lock, session_scope() as s:
        # row lock: a concurrent executor of the same action waits here, then sees 'succeeded'
        act = (await s.execute(select(Action).where(Action.id == action_id).with_for_update())).scalar_one()
        case = await s.get(Case, case.id)
        if act.status == "succeeded":
            await append_audit(s, tenant, "gateway.duplicate_blocked", actor, {"idempotency_key": key, "action_id": act.id, "reason": "already executed by a concurrent request"}, case.id, case.correlation_id)
            cs.guardrail_event(s, tenant, case.id, "duplicate_block", {"idempotency_key": key[:16], "action_id": act.id, "target_id": act.target_id})
            return GatewayResult("duplicate", act.id, {"target_id": act.target_id})
        act.attempts = (act.attempts or 0) + 1
        breaker = get_breaker(f"gateway:{target}", fail_max=3, reset_timeout=30)
        try:
            if a_type == "create_invoice":
                z = await adapter(s, tenant, "zoho")
                # pre-check + retry-after-read: is there already an invoice for this reference?
                found = await breaker.call(lambda: z.find_invoices_by_reference(action_payload.get("reference") or case.po_ref))
                mine = [i for i in found if _invoice_has_key(i, key)]
                others = [i for i in found if not _invoice_has_key(i, key) and i.get("status") != "void"]
                # top-up invoice ("40 more delivered"): the approved, hash-bound payload names the invoices it tops up;
                # only those are expected. Any other invoice for the reference still blocks.
                known = set(action_payload.get("top_up_of") or [])
                others = [i for i in others if i.get("invoice_number") not in known]
                if mine:
                    inv = mine[0]
                    act.status, act.target_id, act.response = "succeeded", inv["invoice_id"], {"adopted_existing": True, "invoice_number": inv.get("invoice_number")}
                    await append_audit(s, tenant, "gateway.adopted_after_read", actor, {"action_id": act.id, "invoice_id": inv["invoice_id"]}, case.id, case.correlation_id)
                    return GatewayResult("succeeded", act.id, {"invoice_id": inv["invoice_id"], "adopted": True})
                if others:
                    act.status, act.error = "failed", f"pre-check: invoice {others[0].get('invoice_number')} already exists for reference"
                    await append_audit(s, tenant, "gateway.duplicate_blocked", actor, {"reason": "existing invoice in Zoho", "invoice": others[0].get("invoice_number")}, case.id, case.correlation_id)
                    cs.guardrail_event(s, tenant, case.id, "duplicate_block", {"reason": "invoice already exists in Zoho", "invoice_number": others[0].get("invoice_number")})
                    return GatewayResult("blocked", act.id, {"reason": "existing_invoice", "invoice_number": others[0].get("invoice_number")})
                payload = _zoho_payload(action_payload, case, key)
                try:
                    inv = await breaker.call(lambda: z.create_invoice(payload, key))
                except ConnectorTimeout:
                    # unknown outcome: read back before any retry
                    found = await z.find_invoices_by_reference(payload["reference_number"])
                    mine = [i for i in found if _invoice_has_key(i, key)]
                    if not mine:
                        act.status, act.error = "unknown", "timeout; read-back found no invoice"
                        await append_audit(s, tenant, "gateway.timeout_unknown", actor, {"action_id": act.id}, case.id, case.correlation_id)
                        return GatewayResult("paused", act.id, {"reason": "write timeout, nothing found on read-back", "connector": "zoho"})
                    inv = mine[0]
                    await append_audit(s, tenant, "gateway.timeout_recovered_by_read", actor, {"action_id": act.id, "invoice_id": inv["invoice_id"]}, case.id, case.correlation_id)
                act.status, act.target_id = "succeeded", inv.get("invoice_id")
                act.response = {"invoice_id": inv.get("invoice_id"), "invoice_number": inv.get("invoice_number"), "total": inv.get("total")}
            else:
                contact_to = action_payload.get("to")
                if not contact_to:
                    z = await adapter(s, tenant, "zoho")
                    contacts = await z.list_contacts()
                    c = next((c for c in contacts if c.get("contact_id") == action_payload.get("customer_id")), {})
                    contact_to = c.get("mobile") or c.get("phone") if target == "whatsapp" else c.get("email")
                if not contact_to:
                    act.status, act.error = "failed", "no recipient for reminder"
                    return GatewayResult("blocked", act.id, {"reason": "no_recipient"})
                if target == "whatsapp":
                    wa = await adapter(s, tenant, "whatsapp")
                    # read-check first: the bridge keeps keys burned after a send, including partial failures
                    prior = await breaker.call(lambda: wa.lookup_send(key))
                    if prior and prior.get("status") == "sent":
                        mid = prior.get("message_id") or f"bridge-dedup:{key[:16]}"
                        act.status, act.target_id, act.response = "succeeded", mid, {"message_id": mid, "adopted_existing": True, "to_redacted": True}
                        await append_audit(s, tenant, "gateway.adopted_after_read", actor, {"action_id": act.id, "message_id": mid}, case.id, case.correlation_id)
                        return GatewayResult("succeeded", act.id, {"message_id": mid, "adopted": True})
                    if prior:
                        act.status, act.error = "unknown", f"whatsapp bridge reports earlier attempt as {prior.get('status')}; outcome unknown"
                        await append_audit(s, tenant, "gateway.outcome_unknown", actor, {"action_id": act.id, "bridge_status": prior.get("status")}, case.id, case.correlation_id)
                        cs.guardrail_event(s, tenant, case.id, "duplicate_block", {"reason": "earlier WhatsApp send has unknown outcome; not re-sending without a human check", "idempotency_key": key[:16]})
                        return GatewayResult("blocked", act.id, {"reason": "whatsapp_outcome_unknown", "bridge_status": prior.get("status")})
                    mid = await breaker.call(lambda: wa.send(contact_to, action_payload["message"], key, approval_id))
                else:
                    gm = await adapter(s, tenant, "gmail")
                    mid = await breaker.call(lambda: gm.send(contact_to, f"Payment reminder: {case.po_ref}", action_payload["message"], key))
                act.status, act.target_id, act.response = "succeeded", mid, {"message_id": mid, "to_redacted": True}
            await append_audit(s, tenant, "gateway.executed", actor, {"action_id": act.id, "type": a_type, "target_id": act.target_id, "idempotency_key": key}, case.id, case.correlation_id)
            return GatewayResult("succeeded", act.id, act.response)
        except (ConnectorUnavailable, CircuitOpenError, ConnectorError) as e:
            act.status, act.error = "failed", str(e)[:400]
            conn = getattr(e, "connector", target)
            if isinstance(e, ConnectorError) and not e.retryable:
                await append_audit(s, tenant, "gateway.rejected_by_target", actor, {"action_id": act.id, "error": str(e)[:200]}, case.id, case.correlation_id)
                return GatewayResult("blocked", act.id, {"reason": f"target rejected the write: {str(e)[:160]}"})
            await append_audit(s, tenant, "gateway.connector_failed", actor, {"action_id": act.id, "error": str(e)[:200]}, case.id, case.correlation_id)
            return GatewayResult("paused", act.id, {"reason": str(e)[:200], "connector": conn})


# ---------------------------------------------------------------------------- verifier
async def verify(action_id: str) -> dict[str, Any]:
    """Independent verifier (no LLM): read the target system back and compare required fields."""
    from .models import Verification

    async with session_scope() as s:
        act = await s.get(Action, action_id)
        case = await s.get(Case, act.case_id)
        req = act.request
        checks: list[dict[str, Any]] = []
        read_back: dict[str, Any] = {}
        if act.type == "create_invoice":
            z = await adapter(s, case.tenant_id, "zoho")
            inv = await z.get_invoice(act.target_id)  # ConnectorUnavailable bubbles -> PAUSED
            read_back = inv or {}

            def chk(name, expected, actual, ok=None):
                checks.append({"field": name, "expected": expected, "actual": actual, "ok": (expected == actual) if ok is None else ok})

            chk("exists", True, inv is not None)
            if inv:
                chk("customer_id", req.get("customer_id"), inv.get("customer_id"))
                chk("reference_number", req.get("reference"), inv.get("reference_number"), refs_match(req.get("reference"), inv.get("reference_number")))
                exp_taxable = Decimal(str(req.get("amount"))).quantize(Decimal("0.01"))
                act_total = Decimal(str(inv.get("total", 0))).quantize(Decimal("0.01"))
                tax_on_invoice = Decimal(str(inv.get("tax_total") or 0)) > 0
                if (req.get("gst") or {}).get("total") is not None and tax_on_invoice:
                    # invoice carries GST: total must equal the approved GST total, taxable value must equal amount
                    exp_total = Decimal(str(req["gst"]["total"])).quantize(Decimal("0.01"))
                    chk("total", str(exp_total), str(act_total), exp_total == act_total)
                    sub = Decimal(str(inv.get("sub_total") if inv.get("sub_total") is not None else sum(float(li.get("item_total", 0)) for li in inv.get("line_items", [])))).quantize(Decimal("0.01"))
                    chk("taxable", str(exp_taxable), str(sub), exp_taxable == sub)
                else:
                    chk("total", str(exp_taxable), str(act_total), exp_taxable == act_total)
                exp_li = sorted((float(li["qty"]), float(li["rate"])) for li in req.get("line_items", []))
                act_li = sorted((float(li.get("quantity", 0)), float(li.get("rate", 0))) for li in inv.get("line_items", []))
                chk("line_items", exp_li, act_li)
                chk("not_void", True, inv.get("status") != "void")
        else:
            checks.append({"field": "message_id", "expected": "present", "actual": act.target_id, "ok": bool(act.target_id)})
        status = "pass" if checks and all(c["ok"] for c in checks) else "fail"
        v = Verification(tenant_id=case.tenant_id, case_id=case.id, action_id=act.id, status=status, checks=checks, read_back=read_back)
        s.add(v)
        await append_audit(s, case.tenant_id, "verifier.result", "verifier", {"action_id": act.id, "status": status, "checks": checks}, case.id, case.correlation_id)
        await s.flush()
        return {"id": v.id, "status": status, "checks": checks, "read_back": read_back}
