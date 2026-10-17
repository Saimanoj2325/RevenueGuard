"""Durable, code-owned case orchestrator.

INTAKE → TRIAGED → WATCHING → EVIDENCE_READY → VALIDATED → INVESTIGATING → PROPOSED → AWAITING_APPROVAL
→ EXECUTING → VERIFYING → CLOSED   (+ PAUSED / ESCALATED / BLOCKED)

Each step loads the case fresh, decides the next action from case state + validator facts, runs at most one
unit of work and commits a checkpoint on every transition. Agents only *advise*; this module decides.
A crashed worker resumes from the latest checkpoint (agent runs on identical evidence are reused, not repeated).
"""
from __future__ import annotations

import hashlib
import math
import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select

from .. import case_service as cs
from ..audit import append_audit
from ..config import get_settings
from ..connectors.base import ConnectorError
from ..connectors.registry import adapter
from ..db import session_scope, utcnow
from ..flags import KILL_SWITCH, chaos_on, get_flag, now as vnow, set_flag
from ..models import Action, Approval, Case, CaseLearning, Proposal, TriageQueueItem
from ..observability import case_id_var, correlation_id_var, get_logger
from ..security import payload_hash
from ..validator import build_timeline, check_proposal, money
from .agents import AgentOutcome, choose_runner, harness_available, run_agent
from .locks import LockBusy, case_lock

log = get_logger("orchestrator")
ACTIVE_STATES = ("INTAKE", "TRIAGED", "WATCHING", "EVIDENCE_READY", "VALIDATED", "INVESTIGATING", "PROPOSED", "AWAITING_APPROVAL", "EXECUTING", "VERIFYING", "PAUSED")


class WorkerKilled(Exception):
    """Simulated worker crash (chaos kill_worker)."""


# ----------------------------------------------------------------------------- helpers
async def _transition(case_id: str, to: str, reason: str, payload: dict[str, Any] | None = None, mutate=None) -> None:
    async with session_scope() as s:
        case = await s.get(Case, case_id)
        if mutate:
            r = mutate(case, s)
            if hasattr(r, "__await__"):
                await r
        await cs.transition(s, case, to, reason, payload)
        tenant = case.tenant_id
        kill = await chaos_on(s, tenant, "kill_worker")
        if kill:
            await set_flag(s, tenant, "chaos:kill_worker", False)
            await append_audit(s, tenant, "worker.killed", "chaos", {"after_state": to}, case.id, case.correlation_id)
    if kill:
        log.warning("chaos.kill_worker", case_id=case_id, after_state=to)
        if os.environ.get("RG_HARD_KILL") == "1":
            os._exit(137)  # real crash of the ARQ worker process; docker restarts it, startup resumes
        raise WorkerKilled(f"worker killed after checkpoint {to}")


async def _escalate(case_id: str, reason: str, detail: dict[str, Any]) -> bool:
    async with session_scope() as s:
        case = await s.get(Case, case_id)
        await cs.open_escalation(s, case, reason, detail)
    await _transition(case_id, "ESCALATED", f"escalated: {reason}", detail)
    return True


async def _pause(case_id: str, connector: str, detail: str) -> bool:
    def m(case, s):
        case.paused_reason = f"connector:{connector} — {detail}"[:500]
        cs.guardrail_event(s, case.tenant_id, case.id, "paused", {"connector": connector, "detail": detail[:300]})

    await _transition(case_id, "PAUSED", f"{connector} unavailable: {detail[:200]}", {"connector": connector}, m)
    return True


async def _handle_agent_failure(case_id: str, out: AgentOutcome) -> bool:
    if out.connector_down:
        return await _pause(case_id, out.connector_down, out.error or "connector unavailable during agent run")
    err = out.error or "unknown"
    if err.startswith("harness_unavailable"):
        return await _pause(case_id, "harness", "agent runtime unreachable")
    if err.startswith("invalid_output"):
        return await _escalate(case_id, "invalid_output", {"agent": out.agent, "run_id": out.run_id, "message": "agent output failed schema validation after 2 retries"})
    if "budget" in err or err == "timeout":
        return await _escalate(case_id, "budget", {"agent": out.agent, "run_id": out.run_id, "message": err})
    return await _escalate(case_id, "agent_error", {"agent": out.agent, "run_id": out.run_id, "message": err[:300]})


def _hash_embedding(text: str, dim: int = 384) -> list[float]:
    """Cheap deterministic hashing-trick embedding so case_learnings is searchable without an embedding API."""
    v = [0.0] * dim
    for tok in text.lower().split():
        h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
        v[h % dim] += 1.0 if (h >> 8) & 1 else -1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


# ----------------------------------------------------------------------------- handlers
async def h_intake(case_id: str) -> bool:
    out = await run_agent(case_id, "triage")
    if not out.ok or out.connector_down:
        return await _handle_agent_failure(case_id, out)
    t = out.output
    s_ = get_settings()
    low = t["genuine_prob"] < s_.triage_confidence_threshold

    async def m(case: Case, s):
        case.triage = t
        case.exception_type = t["exception_type"]
        case.severity = t["severity"]
        case.laya = t.get("laya") or {}
        refs = t.get("refs") or {}
        if refs.get("po") and not case.po_ref:
            from ..validator import normalize_ref

            case.po_ref, case.po_ref_norm = refs["po"], normalize_ref(refs["po"])
        case.customer = case.customer or refs.get("customer")
        if refs.get("amount") is not None and case.amount is None:
            case.amount = refs["amount"]
        case.summary = t.get("summary", "")
        if low:
            case.awaiting_label = True
            s.add(TriageQueueItem(tenant_id=case.tenant_id, case_id=case.id, triage=t, confidence=t["genuine_prob"]))

    if t["exception_type"] == "none" and not low:
        await _transition(case_id, "CLOSED", "triage: no order-to-cash exception", {"triage": t}, m)
        return True
    await _transition(case_id, "TRIAGED", f"triage: {t['exception_type']} ({t['severity']})" + (" — low confidence, sent to triage queue" if low else ""), {"triage": {k: t[k] for k in ("exception_type", "severity", "genuine_prob", "needs_review_prob")}}, m)
    return True


async def h_triaged(case_id: str) -> bool:
    async with session_scope() as s:
        case = await s.get(Case, case_id)
        if case.awaiting_label:
            return False
    await _transition(case_id, "WATCHING", "collect evidence across connected sources")
    return True


async def h_watching(case_id: str) -> bool:
    async with session_scope() as s:
        case = await s.get(Case, case_id)
        now = await vnow(s, case.tenant_id)
        timer_due = case.watch_until is not None and now >= case.watch_until
        if case.watch_until is not None and not timer_due:
            return False
        if not timer_due and (case.facts or {}).get("evidence_checked_ev") == case.evidence_version:
            return False
    out = await run_agent(case_id, "evidence")
    if not out.ok or out.connector_down:
        return await _handle_agent_failure(case_id, out)
    from ..timeline import ensure_fresh

    await ensure_fresh(case_id)  # live mode: new delivery evidence is read by the timeline agent before it is a fact
    async with session_scope() as s:
        case = await s.get(Case, case_id)
        f = await cs.compute_facts(s, case)
        tl = {t["stage"]: t["status"] for t in build_timeline(f)}
        case.facts = {**f.to_json(), "evidence_checked_ev": case.evidence_version, "evidence_summary": out.output.get("summary")}
        case.watch_until = None
        ready = tl["order"] != "missing" and tl["delivery"] != "missing"
        if not ready:
            await append_audit(s, case.tenant_id, "case.watching", "orchestrator", {"missing": [k for k, v in tl.items() if v == "missing"]}, case.id, case.correlation_id)
            cs.queue_event(s, case.tenant_id, {"type": "case.updated", "case_id": case.id, "case_number": case.case_number, "state": case.state})
            return False
    await _transition(case_id, "EVIDENCE_READY", "order and delivery evidence linked", {"timeline": tl})
    return True


async def h_evidence_ready(case_id: str) -> bool:
    from ..timeline import ensure_fresh

    await ensure_fresh(case_id)
    async with session_scope() as s:
        case = await s.get(Case, case_id)
        f = await cs.compute_facts(s, case)
        fj = f.to_json()
        case.facts = {**(case.facts or {}), **fj}
        payload = {"billable": fj["billable"], "conflicts": fj["conflicts"], "duplicates": fj["duplicates"], "order_qty": fj["order_qty"], "delivered_qty": fj["delivered_qty"], "rate": fj["rate"]}
    await _transition(case_id, "VALIDATED", "deterministic validator computed facts", payload)
    return True


async def _route_on_facts(case_id: str, from_investigation: bool, findings: list[str] | None = None) -> str | None:
    """Shared decision table. Returns a target state (or None = continue to resolution)."""
    async with session_scope() as s:
        case = await s.get(Case, case_id)
        f = await cs.compute_facts(s, case)
        case.facts = {**(case.facts or {}), **f.to_json()}
        if f.conflicts:
            return "CONFLICT"
        if len(f.duplicates) > 1:
            return "DUPLICATES"
        if f.duplicates:
            inv_total = sum((d["total"] for d in f.duplicates), Decimal(0))
            if Decimal(0) < f.paid_amount < inv_total:
                return None if from_investigation else "INVESTIGATING"
            amt_due = Decimal(str((f.billable or {}).get("amount_when_due", 0) or 0))
            if amt_due <= 0:
                return "CLOSED:invoice already exists for this reference" + (" (found via alternate-ID search)" if from_investigation else "")
            return None if from_investigation else "INVESTIGATING"
        if not f.billable:
            return "WATCHING:billable inputs incomplete"
        if f.billable.get("not_due"):
            case.watch_until = datetime.fromisoformat(f.billable["due_at"])
            return f"WATCHING:billing not due until {f.billable['due_at'][:10]}"
        if Decimal(str(f.billable["amount"])) <= 0:
            return "WATCHING:nothing billable under billing rule yet"
        return None if from_investigation else "INVESTIGATING"


async def _apply_route(case_id: str, route: str) -> bool:
    if route == "CONFLICT":
        async with session_scope() as s:
            case = await s.get(Case, case_id)
            conflicts = (case.facts or {}).get("conflicts")
        return await _escalate(case_id, "conflict", {"message": "evidence sources disagree", "conflicts": conflicts})
    if route == "DUPLICATES":
        async with session_scope() as s:
            case = await s.get(Case, case_id)
            dups = (case.facts or {}).get("duplicates")
        return await _escalate(case_id, "duplicate_invoices", {"message": "more than one invoice exists for this reference; needs credit-note review", "duplicates": dups})
    target, _, reason = route.partition(":")
    await _transition(case_id, target, reason or f"route to {target}")
    return True


async def h_validated(case_id: str) -> bool:
    route = await _route_on_facts(case_id, from_investigation=False)
    if route == "INVESTIGATING":
        async with session_scope() as s:
            case = await s.get(Case, case_id)
            f = case.facts or {}
        why = "invoice not found on first search; investigate before proposing" if not f.get("duplicates") else "invoice exists with partial payment / partial billing; investigate"
        await _transition(case_id, "INVESTIGATING", why)
        return True
    if route is None:
        await _transition(case_id, "INVESTIGATING", "investigate")
        return True
    if route == "CONFLICT":
        await _transition(case_id, "INVESTIGATING", "conflicting evidence: look for corrections before escalating")
        return True
    return await _apply_route(case_id, route)


async def h_investigating(case_id: str) -> bool:
    out = await run_agent(case_id, "investigation", mode=get_settings().investigation_mode)
    if not out.ok or out.connector_down:
        return await _handle_agent_failure(case_id, out)
    inv = out.output
    from ..timeline import ensure_fresh

    await ensure_fresh(case_id)  # the investigation may have found more delivery messages
    if inv["stop_reason"] == "budget":
        return await _escalate(case_id, "budget", {"message": "investigation step budget exhausted", "findings": inv["findings"]})
    route = await _route_on_facts(case_id, from_investigation=True, findings=inv["findings"])
    if route is not None:
        return await _apply_route(case_id, route)
    await ensure_customer(case_id)
    res = await run_agent(case_id, "resolution")
    if not res.ok or res.connector_down:
        return await _handle_agent_failure(case_id, res)
    r = res.output

    async def m(case: Case, s):
        action = r["action"]
        if action.get("type") == "create_invoice":
            from ..invoicing import attach_gst

            action = await attach_gst(s, case.tenant_id, action)  # deterministic GST lines; re-derived by the validator step
        await _new_proposal(s, case, action, r["claims"], r["uncertainty"], r["risk"], created_by=f"agent:resolution:{res.run_id[:8]}", validation={"findings": inv["findings"]})

    await _transition(case_id, "PROPOSED", f"resolution proposed {r['action']['type']} ₹{r['action'].get('amount', 0)}", {"action": r["action"], "risk": r["risk"]}, m)
    return True


async def ensure_customer(case_id: str) -> str | None:
    """Deterministically resolve the accounting customer id (Zoho contact) from the customer name on the evidence.
    The lookup result is stored as a source-linked evidence node so the proposal can cite it."""
    async with session_scope() as s:
        case = await s.get(Case, case_id)
        f = await cs.compute_facts(s, case)
        if f.customer_id:
            return f.customer_id
        name = f.customer_name or case.customer
        if not name:
            return None
        try:
            contacts = await (await adapter(s, case.tenant_id, "zoho")).list_contacts(name)
        except ConnectorError:
            return None
        exact = [c for c in contacts if (c.get("contact_name") or "").strip().lower() == name.strip().lower()]
        if len(exact) != 1:
            await append_audit(s, case.tenant_id, "customer.unresolved", "orchestrator", {"name": name, "candidates": len(contacts)}, case.id, case.correlation_id)
            return None
        c = exact[0]
        await cs.add_evidence(s, case, case.tenant_id, kind="contact", source="zoho", source_id=f"contact:{c['contact_id']}", title=f"Zoho contact {c['contact_name']}",
                              excerpt=f"contact_id={c['contact_id']}", fields={"customer_id": c["contact_id"], "customer": c["contact_name"]}, actor="orchestrator", material=False)
        return c["contact_id"]


async def _new_proposal(s, case: Case, action: dict, claims: list, uncertainty: list, risk: str, created_by: str, validation: dict | None = None) -> Proposal:
    prev = (await s.execute(select(Proposal).where(Proposal.case_id == case.id).order_by(Proposal.version.desc()).limit(1))).scalar_one_or_none()
    for p in (await s.execute(select(Proposal).where(Proposal.case_id == case.id, Proposal.status == "active"))).scalars().all():
        p.status = "superseded"
    prop = Proposal(tenant_id=case.tenant_id, case_id=case.id, version=(prev.version + 1) if prev else 1, payload=action, payload_hash=payload_hash(action),
                    claims=claims, uncertainty=uncertainty, risk=risk, validation=validation or {}, evidence_version=case.evidence_version, created_by=created_by)
    s.add(prop)
    await s.flush()
    await append_audit(s, case.tenant_id, "proposal.created", created_by, {"proposal_id": prop.id, "version": prop.version, "payload_hash": prop.payload_hash, "amount": action.get("amount")}, case.id, case.correlation_id)
    return prop


async def h_proposed(case_id: str) -> bool:
    await ensure_customer(case_id)
    async with session_scope() as s:
        case = await s.get(Case, case_id)
        prop = (await s.execute(select(Proposal).where(Proposal.case_id == case_id, Proposal.status == "active").order_by(Proposal.version.desc()).limit(1))).scalar_one_or_none()
        if prop is None:
            pass
        else:
            f = await cs.compute_facts(s, case)
            chk = check_proposal({"action": prop.payload, "claims": prop.claims}, cs.facts_for_check(f, case))
            prop.validation = {**(prop.validation or {}), "check": chk}
            a_type = prop.payload.get("type")
    if prop is None:
        await _transition(case_id, "INVESTIGATING", "no active proposal")
        return True
    if a_type == "none":
        await _transition(case_id, "CLOSED", "resolution: no action required", {"proposal_id": prop.id})
        return True
    if not chk["ok"]:
        errs = chk["errors"]
        if "duplicate_invoice_exists" in errs:
            def m(case, s):
                cs.guardrail_event(s, case.tenant_id, case.id, "duplicate_block", {"reason": "proposal would duplicate an existing invoice", "proposal_id": prop.id})
            await _transition(case_id, "BLOCKED", "policy: proposal duplicates an existing invoice", {"errors": errs}, m)
            return True
        if "customer_unresolved" in errs:
            return await _escalate(case_id, "customer_unresolved", {"message": "could not match the customer to exactly one accounting contact", "errors": errs})
        if "nothing_billable" in errs:
            await _transition(case_id, "WATCHING", "policy: nothing billable yet", {"errors": errs})
            return True
        async with session_scope() as s:
            case = await s.get(Case, case_id)
            rc = dict(case.retry_counts or {})
            rc["resolution_invalid"] = rc.get("resolution_invalid", 0) + 1
            case.retry_counts = rc
            n = rc["resolution_invalid"]
            p = await s.get(Proposal, prop.id)
            p.status = "invalid"
        if n > 2:
            return await _escalate(case_id, "invalid_output", {"message": "proposal failed policy check after 2 retries", "errors": errs})
        await _transition(case_id, "INVESTIGATING", f"policy check failed ({'; '.join(errs)[:200]}); retry {n}/2", {"errors": errs})
        return True

    async def m(case: Case, s):
        p = await s.get(Proposal, prop.id)
        corrected = chk["corrected_action"]
        if corrected.get("type") == "create_invoice":
            from ..invoicing import attach_gst

            corrected = await attach_gst(s, case.tenant_id, corrected)  # GST lines are part of the approved, hashed payload
        if payload_hash(corrected) != p.payload_hash:
            p = await _new_proposal(s, case, corrected, p.claims, p.uncertainty, p.risk, created_by="validator", validation={"check": chk, "overrode_version": p.version})
        amount = corrected.get("amount") or 0
        from ..gateway import required_approvers

        ap = Approval(tenant_id=case.tenant_id, case_id=case.id, proposal_id=p.id, payload_hash=p.payload_hash, evidence_version=case.evidence_version,
                      amount=amount, required_approvers=required_approvers(amount), status="pending")
        s.add(ap)
        await s.flush()
        await append_audit(s, case.tenant_id, "approval.requested", "orchestrator", {"approval_id": ap.id, "proposal_id": p.id, "amount": amount, "required_approvers": ap.required_approvers, "payload_hash": p.payload_hash}, case.id, case.correlation_id)
        cs.queue_event(s, case.tenant_id, {"type": "approval.updated", "approval": cs.approval_json(ap)})

    await _transition(case_id, "AWAITING_APPROVAL", "policy check passed; human approval required", {"warnings": chk["warnings"]}, m)
    from ..notify import approval_created

    await approval_created(case_id)  # best-effort WhatsApp prompt to linked approver phones; never blocks
    return True


async def h_awaiting(case_id: str) -> bool:
    async with session_scope() as s:
        ap = (await s.execute(select(Approval).where(Approval.case_id == case_id).order_by(Approval.created_at.desc()).limit(1))).scalar_one_or_none()
        status = ap.status if ap else None
        reason = ap.rejected_reason if ap else None
    if status == "approved":
        await _transition(case_id, "EXECUTING", "approval complete; executing via gateway", {"approval_id": ap.id})
        return True
    if status == "rejected":
        return await _escalate(case_id, "approval_rejected", {"message": reason or "rejected by approver", "approval_id": ap.id})
    if status == "expired" or status is None:
        await _transition(case_id, "INVESTIGATING", "approval expired; re-investigate on current evidence")
        return True
    return False


async def h_executing(case_id: str) -> bool:
    from ..gateway import execute

    async with session_scope() as s:
        ap = (await s.execute(select(Approval).where(Approval.case_id == case_id).order_by(Approval.created_at.desc()).limit(1))).scalar_one_or_none()
    res = await execute(ap.id, actor="orchestrator")
    if res.status in ("succeeded",) or (res.status == "duplicate" and res.action_id):
        await _transition(case_id, "VERIFYING", f"gateway {res.status}; independent read-back", {"action_id": res.action_id, **{k: v for k, v in res.detail.items() if k != 'to'}})
        return True
    if res.status == "paused":
        return await _pause(case_id, res.detail.get("connector", "zoho"), res.detail.get("reason", "write failed"))
    if res.status == "stale":
        async with session_scope() as s:
            case = await s.get(Case, case_id)
            st = case.state
        if st == "EXECUTING":
            await _transition(case_id, "INVESTIGATING", "approval went stale before execution; re-investigate on current evidence")
        return True
    if res.status == "duplicate":
        return False
    await _transition(case_id, "BLOCKED", f"gateway blocked: {res.detail.get('reason')}", res.detail)
    return True


async def h_verifying(case_id: str) -> bool:
    from ..gateway import verify

    async with session_scope() as s:
        act = (await s.execute(select(Action).where(Action.case_id == case_id, Action.status == "succeeded").order_by(Action.created_at.desc()).limit(1))).scalar_one_or_none()
    if act is None:
        return await _escalate(case_id, "verification_failed", {"message": "no succeeded action to verify"})
    try:
        v = await verify(act.id)
    except ConnectorError as e:
        return await _pause(case_id, e.connector, f"verifier read-back failed: {e}")
    if v["status"] != "pass":
        return await _escalate(case_id, "verification_failed", {"message": "read-back mismatch", "checks": v["checks"]})

    async def m(case: Case, s):
        a = await s.get(Action, act.id)
        text = (f"{case.case_number} {case.po_ref} {case.customer}: {case.exception_type}; executed {a.type} {a.response.get('invoice_number', a.target_id)} "
                f"₹{a.request.get('amount')} after evidence v{case.evidence_version}; verifier pass.")
        s.add(CaseLearning(tenant_id=case.tenant_id, case_id=case.id, text=text, tags=[case.exception_type or "", a.type], embedding=_hash_embedding(text)))
        if a.type == "create_invoice" and v.get("read_back"):
            from ..tools.registry import _invoice_fields

            inv = v["read_back"]
            node, _ = await cs.add_evidence(s, case, case.tenant_id, kind="invoice", source="zoho", source_id=f"inv:{inv.get('invoice_id')}",
                                            title=f"Zoho invoice {inv.get('invoice_number')} (created via gateway, verified)", excerpt=str({k: inv.get(k) for k in ("invoice_number", "reference_number", "total", "status")}),
                                            fields=_invoice_fields(inv), actor="verifier", material=False)

    await _transition(case_id, "CLOSED", "verifier passed: target system matches approved action", {"verification_id": v["id"]}, m)
    from ..notify import action_verified

    await action_verified(case_id, act.id)  # best-effort "Done. Invoice ... checked" to the approvers
    return True


async def _connector_healthy(s, tenant_id: str, name: str) -> bool:
    if name == "kill_switch":
        return not await get_flag(s, tenant_id, KILL_SWITCH, False)
    if name == "harness":
        return await harness_available() or (await choose_runner()) != "harness"
    try:
        a = await adapter(s, tenant_id, name)
        if name == "zoho":
            await a.list_contacts()
        elif name == "sheets":
            await a.read_delivery("__healthcheck__")
        elif name == "gmail":
            await a.search("__healthcheck__", limit=1)
        elif name == "whatsapp":
            st = await a.status()
            return st.get("state") == "open"
        return True
    except ConnectorError:
        return False


async def h_paused(case_id: str) -> bool:
    async with session_scope() as s:
        case = await s.get(Case, case_id)
        reason = case.paused_reason or ""
        name = reason.split(" ")[0].replace("connector:", "") if reason.startswith("connector:") else None
        back_to = case.paused_from or "INVESTIGATING"
        ok = await _connector_healthy(s, case.tenant_id, name) if name else True
    if not ok:
        return False

    def m(case, s):
        case.paused_reason = None
        case.paused_from = None

    await _transition(case_id, back_to, f"resumed: {name or 'cause'} healthy again", {"connector": name}, m)
    return True


HANDLERS = {
    "INTAKE": h_intake, "TRIAGED": h_triaged, "WATCHING": h_watching, "EVIDENCE_READY": h_evidence_ready, "VALIDATED": h_validated,
    "INVESTIGATING": h_investigating, "PROPOSED": h_proposed, "AWAITING_APPROVAL": h_awaiting, "EXECUTING": h_executing,
    "VERIFYING": h_verifying, "PAUSED": h_paused,
}


async def step_case(case_id: str) -> bool:
    s_ = get_settings()
    async with session_scope() as s:
        case = await s.get(Case, case_id)
        if case is None or case.state not in HANDLERS:
            return False
        correlation_id_var.set(case.correlation_id)
        case_id_var.set(case.case_number)
        state = case.state
        used = case.budget_used or {}
        over = int(used.get("agent_runs", 0)) >= s_.case_budget_max_agent_runs or float(used.get("cost_inr", 0)) >= s_.case_budget_max_cost_inr
    if over and state not in ("AWAITING_APPROVAL", "EXECUTING", "VERIFYING", "PAUSED"):
        return await _escalate(case_id, "budget", {"message": f"case budget exhausted: {used}"})
    return await HANDLERS[state](case_id)


async def drive_case(case_id: str, max_steps: int = 40, wait_seconds: float = 120.0, stop_at: tuple[str, ...] = ()) -> str:
    """Advance a case until it needs a human, a timer, or a connector. Returns final state.
    `stop_at`: optional states at which to stop before running their handler (used by the demo presenter to
    pace one beat per scene; the orchestrator itself never sets it)."""
    async with case_lock(case_id, wait_seconds):
        for i in range(max_steps):
            async with session_scope() as s:
                c = await s.get(Case, case_id)
                if c is None:
                    break
                if c.state in stop_at:
                    break
                # a case that became PAUSED during THIS drive is not retried in the same drive (no hot loops);
                # the sweep / an explicit resume / the next event picks it up.
                if i > 0 and c.state == "PAUSED":
                    break
            try:
                progressed = await step_case(case_id)
            except WorkerKilled:
                raise
            except cs.TransitionError as e:
                log.error("orchestrator.bad_transition", error=str(e))
                break
            if not progressed:
                break
    async with session_scope() as s:
        c = await s.get(Case, case_id)
        return c.state if c else "MISSING"


async def resume_all(tenant_id: str | None = None) -> list[dict[str, Any]]:
    """Worker startup: resume every non-terminal case from its latest checkpoint."""
    from .locks import break_stale_locks_for_host

    await break_stale_locks_for_host()
    async with session_scope() as s:
        q = select(Case.id).where(Case.state.in_(ACTIVE_STATES))
        if tenant_id:
            q = q.where(Case.tenant_id == tenant_id)
        ids = (await s.execute(q.order_by(Case.updated_at))).scalars().all()
        info = []
        for cid in ids:
            cp = await cs.latest_checkpoint(s, cid)
            info.append({"case_id": cid, "from_checkpoint_seq": cp.seq if cp else None, "state": cp.state if cp else None})
            if cp:
                c = await s.get(Case, cid)
                await append_audit(s, c.tenant_id, "worker.resume", "worker", {"checkpoint_seq": cp.seq, "state": cp.state}, cid, c.correlation_id)
    for item in info:
        try:
            item["final_state"] = await drive_case(item["case_id"], wait_seconds=35)
        except LockBusy:
            item["final_state"] = "LOCKED"
    return info
