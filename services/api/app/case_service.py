"""Case state, checkpoints, evidence graph and approval-expiry primitives (code-owned, never LLM-owned)."""
from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

from sqlalchemy import event as sa_event
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from .audit import append_audit
from .db import utcnow
from .events import bus
from .models import Approval, Case, CaseCheckpoint, Escalation, EvidenceEdge, EvidenceNode, Proposal, Tenant
from .observability import get_logger
from .security import sha256_text
from .untrusted import wrap_untrusted
from . import validator

log = get_logger("case")

STATES = [
    "INTAKE", "TRIAGED", "WATCHING", "EVIDENCE_READY", "VALIDATED", "INVESTIGATING", "PROPOSED",
    "AWAITING_APPROVAL", "EXECUTING", "VERIFYING", "CLOSED", "PAUSED", "ESCALATED", "BLOCKED",
]
SIDE = {"PAUSED", "ESCALATED", "BLOCKED"}
TERMINAL = {"CLOSED"}
ALLOWED: dict[str, set[str]] = {
    "INTAKE": {"TRIAGED", "CLOSED"},
    "TRIAGED": {"WATCHING"},
    "WATCHING": {"WATCHING", "EVIDENCE_READY", "CLOSED"},
    "EVIDENCE_READY": {"VALIDATED"},
    "VALIDATED": {"INVESTIGATING", "PROPOSED", "WATCHING", "CLOSED"},
    "INVESTIGATING": {"PROPOSED", "WATCHING", "CLOSED", "INVESTIGATING"},
    "PROPOSED": {"AWAITING_APPROVAL", "INVESTIGATING", "WATCHING", "CLOSED"},
    "AWAITING_APPROVAL": {"EXECUTING", "INVESTIGATING", "PROPOSED"},
    "EXECUTING": {"VERIFYING", "INVESTIGATING"},
    "VERIFYING": {"CLOSED"},
    "PAUSED": set(STATES) - {"PAUSED"},
    "ESCALATED": {"INVESTIGATING", "WATCHING", "CLOSED", "PROPOSED"},
    "BLOCKED": {"INVESTIGATING", "CLOSED", "ESCALATED"},
    "CLOSED": set(),
}
# any non-terminal state may go to a side state
for _s in STATES:
    if _s not in TERMINAL:
        ALLOWED.setdefault(_s, set()).update(SIDE - {_s})


class TransitionError(Exception):
    pass


# --------------------------------------------------------------------- events after commit
def queue_event(session: AsyncSession, tenant_id: str, event: dict[str, Any]) -> None:
    session.sync_session.info.setdefault("rg_events", []).append((tenant_id, event))


@sa_event.listens_for(Session, "after_commit")
def _after_commit(sync_session: Session) -> None:
    evs = sync_session.info.pop("rg_events", [])
    if not evs:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    for tenant_id, ev in evs:
        loop.create_task(bus.publish(tenant_id, ev))


@sa_event.listens_for(Session, "after_rollback")
def _after_rollback(sync_session: Session) -> None:
    sync_session.info.pop("rg_events", None)


def guardrail_event(session: AsyncSession, tenant_id: str, case_id: str | None, kind: str, detail: Any) -> None:
    queue_event(session, tenant_id, {"type": "guardrail", "case_id": case_id, "kind": kind, "detail": detail})


# --------------------------------------------------------------------- case numbers
async def next_case_number(session: AsyncSession, tenant_id: str) -> str:
    res = await session.execute(update(Tenant).where(Tenant.id == tenant_id).values(case_seq=Tenant.case_seq + 1).returning(Tenant.case_seq))
    return f"RG-{res.scalar_one()}"


# --------------------------------------------------------------------- transitions
async def transition(session: AsyncSession, case: Case, to: str, reason: str, payload: dict[str, Any] | None = None, actor: str = "orchestrator") -> CaseCheckpoint:
    frm = case.state
    if to not in ALLOWED.get(frm, set()):
        raise TransitionError(f"{case.case_number}: {frm} -> {to} not allowed")
    if to == "PAUSED" and frm != "PAUSED":
        case.paused_from = frm
    case.state = to
    case.updated_at = utcnow()
    if to == "CLOSED":
        case.closed_at = utcnow()
    seq = ((await session.execute(select(func.max(CaseCheckpoint.seq)).where(CaseCheckpoint.case_id == case.id))).scalar() or 0) + 1
    cp = CaseCheckpoint(
        tenant_id=case.tenant_id, case_id=case.id, seq=seq, from_state=frm, state=to, reason=reason,
        payload=payload or {}, evidence_version=case.evidence_version, correlation_id=case.correlation_id,
    )
    session.add(cp)
    await append_audit(session, case.tenant_id, "case.transition", actor, {"from": frm, "to": to, "reason": reason, "seq": seq, "evidence_version": case.evidence_version}, case.id, case.correlation_id)
    queue_event(session, case.tenant_id, {"type": "case.updated", "case_id": case.id, "case_number": case.case_number, "state": to})
    queue_event(session, case.tenant_id, {"type": "checkpoint", "case_id": case.id, "state": to, "seq": seq, "reason": reason})
    await session.flush()
    log.info("case.transition", case=case.case_number, frm=frm, to=to, reason=reason, seq=seq)
    return cp


async def latest_checkpoint(session: AsyncSession, case_id: str) -> CaseCheckpoint | None:
    return (await session.execute(select(CaseCheckpoint).where(CaseCheckpoint.case_id == case_id).order_by(CaseCheckpoint.seq.desc()).limit(1))).scalar_one_or_none()


# --------------------------------------------------------------------- evidence
async def add_evidence(
    session: AsyncSession,
    case: Case | None,
    tenant_id: str,
    *,
    kind: str,
    source: str,
    source_id: str,
    title: str,
    excerpt: str = "",
    fields: dict[str, Any] | None = None,
    ts: datetime | None = None,
    media_object_key: str | None = None,
    mime: str | None = None,
    derived_text: str | None = None,
    quarantined: bool = False,
    injection_prob: float | None = None,
    actor: str = "intake",
    material: bool = True,
) -> tuple[EvidenceNode, bool]:
    """Idempotent on (tenant, case, source, source_id). Returns (node, created).
    A new material node bumps case.evidence_version and expires any pending approval."""
    case_id = case.id if case else None
    existing = (
        await session.execute(
            select(EvidenceNode).where(
                EvidenceNode.tenant_id == tenant_id, EvidenceNode.case_id == case_id, EvidenceNode.source == source, EvidenceNode.source_id == source_id
            )
        )
    ).scalar_one_or_none()
    if existing:
        return existing, False
    content_hash = sha256_text(f"{title}\n{excerpt}\n{derived_text or ''}\n{sorted((fields or {}).items())}")
    node = EvidenceNode(
        tenant_id=tenant_id, case_id=case_id, kind=kind, source=source, source_id=source_id, ts=ts or utcnow(), title=title[:300],
        excerpt=(excerpt or "")[:4000], fields=fields or {}, media_object_key=media_object_key, mime=mime, derived_text=derived_text,
        untrusted_flag=source in ("gmail", "whatsapp", "drive", "media", "sheets"), quarantined=quarantined, injection_prob=injection_prob,
        content_hash=content_hash,
    )
    session.add(node)
    await session.flush()
    if case is not None:
        if material and not quarantined:
            case.evidence_version = (case.evidence_version or 0) + 1
            node.evidence_version = case.evidence_version
            await expire_approvals_on_evidence_change(session, case, reason=f"new evidence {kind} from {source} ({node.id[:8]})")
        await append_audit(session, tenant_id, "evidence.added", actor, {"node_id": node.id, "kind": kind, "source": source, "source_id": source_id, "quarantined": quarantined, "evidence_version": case.evidence_version}, case.id, case.correlation_id)
    return node, True


async def add_edge(session: AsyncSession, case: Case, frm: str, to: str, label: str) -> None:
    exists = (await session.execute(select(EvidenceEdge.id).where(EvidenceEdge.case_id == case.id, EvidenceEdge.from_id == frm, EvidenceEdge.to_id == to, EvidenceEdge.label == label))).first()
    if not exists and frm != to:
        session.add(EvidenceEdge(tenant_id=case.tenant_id, case_id=case.id, from_id=frm, to_id=to, label=label))
        await session.flush()


async def expire_approvals_on_evidence_change(session: AsyncSession, case: Case, reason: str) -> int:
    pend = (
        await session.execute(select(Approval).where(Approval.case_id == case.id, Approval.status.in_(("pending", "partially_approved", "approved"))))
    ).scalars().all()
    n = 0
    for ap in pend:
        if ap.evidence_version == case.evidence_version:
            continue
        # an approved approval whose action already ran is history, not stale
        if ap.status == "approved" and case.state in ("EXECUTING", "VERIFYING", "CLOSED"):
            continue
        ap.status = "expired"
        ap.expires_reason = f"evidence_version {ap.evidence_version} -> {case.evidence_version}: {reason}"
        ap.decided_at = utcnow()
        n += 1
        await append_audit(session, case.tenant_id, "approval.expired", "system", {"approval_id": ap.id, "reason": ap.expires_reason}, case.id, case.correlation_id)
        queue_event(session, case.tenant_id, {"type": "approval.updated", "approval": approval_json(ap)})
        guardrail_event(session, case.tenant_id, case.id, "approval_expired", {"approval_id": ap.id, "reason": ap.expires_reason})
        prop = await session.get(Proposal, ap.proposal_id)
        if prop and prop.status == "active":
            prop.status = "superseded"
    if n and case.state == "AWAITING_APPROVAL":
        await transition(session, case, "INVESTIGATING", "approval expired: material evidence changed", {"expired": n})
    return n


async def case_nodes(session: AsyncSession, case: Case) -> list[EvidenceNode]:
    return list((await session.execute(select(EvidenceNode).where(EvidenceNode.tenant_id == case.tenant_id, EvidenceNode.case_id == case.id).order_by(EvidenceNode.ts, EvidenceNode.created_at))).scalars().all())


def node_dict(n: EvidenceNode) -> dict[str, Any]:
    return {
        "id": n.id, "kind": n.kind, "source": n.source, "source_id": n.source_id, "ts": n.ts.isoformat() if n.ts else None,
        "title": n.title, "excerpt": n.excerpt, "fields": n.fields or {}, "quarantined": n.quarantined,
        "untrusted_flag": n.untrusted_flag, "injection_prob": n.injection_prob, "evidence_version": n.evidence_version,
        "media_url": f"/media/{n.id}" if n.media_object_key else None, "derived_text": n.derived_text,
    }


# --------------------------------------------------------------------- facts
async def billing_rule_for(session: AsyncSession, tenant_id: str, customer_id: str | None) -> dict[str, Any]:
    from .flags import get_flag

    rules = await get_flag(session, tenant_id, "billing_rules", None) or {"default": {"mode": "on_delivery", "delay_days": 0, "allow_partial": True}}
    if customer_id and customer_id in (rules.get("customers") or {}):
        return rules["customers"][customer_id]
    return rules.get("default", {"mode": "on_delivery"})


async def compute_facts(session: AsyncSession, case: Case) -> validator.Facts:
    from .flags import now as vnow

    from . import timeline

    # deleted and resent (duplicate) messages are kept for audit but never give a fact
    nodes = [node_dict(n) for n in await case_nodes(session, case) if (n.fields or {}).get("status") not in timeline.HIDDEN]
    cust = next((n["fields"].get("customer_id") for n in nodes if n["fields"].get("customer_id") and not n["quarantined"]), None)
    rule = await billing_rule_for(session, case.tenant_id, cust)
    now = await vnow(session, case.tenant_id)
    f = validator.derive_facts(nodes, case.po_ref, rule, now=now)
    # live mode: the timeline agent's verified decision replaces the static delivery rules (demo: no-op)
    await timeline.apply_agent_facts(session, case, f, nodes, now)
    return f


def facts_for_check(f: validator.Facts, case: Case) -> dict[str, Any]:
    return {
        "evidence_node_ids": f.evidence_node_ids,
        "quarantined_node_ids": f.quarantined_node_ids,
        "billable": f.billable,
        "duplicates": f.duplicates,
        "customer_id": f.customer_id,
        "customer_name": f.customer_name,
        "reference": case.po_ref,
        "item": f.item,
    }


async def snapshot(session: AsyncSession, case: Case) -> dict[str, Any]:
    """Case snapshot handed to agents. All external text is wrapped as untrusted."""
    nodes = await case_nodes(session, case)
    f = await compute_facts(session, case)
    ev = []
    for n in nodes:
        if n.quarantined:
            continue
        text = "\n".join(x for x in (n.excerpt, n.derived_text) if x)
        ev.append({"id": n.id, "kind": n.kind, "source": n.source, "source_id": n.source_id, "ts": n.ts.isoformat() if n.ts else None,
                   "title": n.title, "fields": n.fields, "content": wrap_untrusted(text, n.source, n.source_id, preamble=False)})
    from .untrusted import UNTRUSTED_PREAMBLE

    return {
        "case": {"id": case.id, "case_number": case.case_number, "state": case.state, "exception_type": case.exception_type, "severity": case.severity,
                 "po_ref": case.po_ref, "customer": case.customer, "amount": float(case.amount) if case.amount is not None else None,
                 "evidence_version": case.evidence_version},
        "untrusted_content_policy": UNTRUSTED_PREAMBLE,
        "evidence": ev,
        "quarantined_node_ids": [n.id for n in nodes if n.quarantined],
        "facts": f.to_json(),
        "timeline": validator.build_timeline(f),
        "triage": case.triage or {},
    }


# --------------------------------------------------------------------- escalation / json helpers
async def open_escalation(session: AsyncSession, case: Case, reason: str, detail: dict[str, Any]) -> Escalation:
    esc = Escalation(tenant_id=case.tenant_id, case_id=case.id, reason=reason, detail=detail)
    session.add(esc)
    case.escalation_reason = f"{reason}: {detail.get('message', '')}".strip(": ")
    await session.flush()
    await append_audit(session, case.tenant_id, "case.escalated", "orchestrator", {"reason": reason, **detail}, case.id, case.correlation_id)
    guardrail_event(session, case.tenant_id, case.id, "escalated", {"reason": reason, **detail})
    return esc


def approval_json(a: Approval) -> dict[str, Any]:
    return {
        "id": a.id, "case_id": a.case_id, "proposal_id": a.proposal_id, "payload_hash": a.payload_hash, "evidence_version": a.evidence_version,
        "status": a.status, "required_approvers": a.required_approvers, "approvers": a.approvers or [], "expires_reason": a.expires_reason,
        "rejected_reason": a.rejected_reason, "amount": float(a.amount) if a.amount is not None else None,
        "created_at": a.created_at.isoformat() if a.created_at else None,
    }


def case_json(c: Case) -> dict[str, Any]:
    return {
        "id": c.id, "case_number": c.case_number, "state": c.state, "exception_type": c.exception_type, "severity": c.severity,
        "title": c.title, "summary": c.summary, "customer": c.customer, "po_ref": c.po_ref,
        "amount": float(c.amount) if c.amount is not None else None, "evidence_version": c.evidence_version,
        "correlation_id": c.correlation_id, "budget_used": c.budget_used, "paused_reason": c.paused_reason,
        "escalation_reason": c.escalation_reason, "watch_until": c.watch_until.isoformat() if c.watch_until else None,
        "awaiting_label": c.awaiting_label, "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None, "closed_at": c.closed_at.isoformat() if c.closed_at else None,
    }
