"""Web-facing endpoints: auth, cases, approvals, triage queue, escalations, audit, metrics, eval, admin."""
from __future__ import annotations

import json
import statistics
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import case_service as cs
from ..approvals import ApprovalError, approve, edit, reject
from ..audit import append_audit, verify_chain
from ..config import get_settings
from ..db import get_session
from ..deps import current_user, require_role
from ..flags import KILL_SWITCH, set_flag
from ..models import (
    Action, AgentEvent, AgentRun, Approval, AuditLog, Case, CaseCheckpoint, Escalation, EvidenceEdge, EvidenceNode, Proposal,
    ToolCall, TriageQueueItem, User, Verification,
)
from ..security import create_token, verify_password
from ..validator import build_timeline

router = APIRouter()


# ------------------------------------------------------------------ auth
class LoginBody(BaseModel):
    email: EmailStr
    password: str


def user_json(u: User) -> dict[str, Any]:
    return {"id": u.id, "email": u.email, "name": u.name, "role": u.role, "tenant_id": u.tenant_id}


@router.post("/auth/login")
async def login(body: LoginBody, session: AsyncSession = Depends(get_session)):
    u = (await session.execute(select(User).where(User.email == body.email.lower()))).scalar_one_or_none()
    if u is None or not verify_password(body.password, u.password_hash):
        raise HTTPException(401, "invalid credentials")
    await append_audit(session, u.tenant_id, "auth.login", u.email, {"role": u.role})
    await session.commit()
    return {"token": create_token(u.id, u.tenant_id, u.role, u.email), "user": user_json(u)}


@router.get("/me")
async def me(user: User = Depends(current_user)):
    return user_json(user)


# ------------------------------------------------------------------ cases
async def _get_case(session: AsyncSession, user: User, case_ref: str) -> Case:
    c = (await session.execute(select(Case).where(Case.tenant_id == user.tenant_id, or_(Case.id == case_ref, Case.case_number == case_ref)))).scalar_one_or_none()
    if c is None:
        raise HTTPException(404, "case not found")
    return c


@router.get("/cases")
async def list_cases(status: Optional[str] = None, severity: Optional[str] = None, q: Optional[str] = None, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    stmt = select(Case).where(Case.tenant_id == user.tenant_id)
    if status:
        stmt = stmt.where(Case.state.in_(status.upper().split(",")))
    if severity:
        stmt = stmt.where(Case.severity.in_(severity.lower().split(",")))
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(Case.case_number.ilike(like), Case.po_ref.ilike(like), Case.customer.ilike(like), Case.title.ilike(like)))
    rows = (await session.execute(stmt.order_by(Case.updated_at.desc()).limit(200))).scalars().all()
    return {"cases": [cs.case_json(c) for c in rows]}


@router.get("/cases/{case_ref}")
async def get_case(case_ref: str, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    c = await _get_case(session, user, case_ref)
    nodes = await cs.case_nodes(session, c)
    edges = (await session.execute(select(EvidenceEdge).where(EvidenceEdge.case_id == c.id))).scalars().all()
    facts = await cs.compute_facts(session, c)
    runs = (await session.execute(select(AgentRun).where(AgentRun.case_id == c.id).order_by(AgentRun.started_at))).scalars().all()
    cps = (await session.execute(select(CaseCheckpoint).where(CaseCheckpoint.case_id == c.id).order_by(CaseCheckpoint.seq))).scalars().all()
    props = (await session.execute(select(Proposal).where(Proposal.case_id == c.id).order_by(Proposal.version))).scalars().all()
    aps = (await session.execute(select(Approval).where(Approval.case_id == c.id).order_by(Approval.created_at))).scalars().all()
    acts = (await session.execute(select(Action).where(Action.case_id == c.id).order_by(Action.created_at))).scalars().all()
    ver = (await session.execute(select(Verification).where(Verification.case_id == c.id).order_by(Verification.created_at.desc()).limit(1))).scalar_one_or_none()
    active = next((p for p in reversed(props) if p.status == "active"), props[-1] if props else None)
    return {
        "case": cs.case_json(c),
        "timeline": build_timeline(facts),
        "facts": facts.to_json(),
        "evidence": {
            "nodes": [{**cs.node_dict(n), "untrusted_flag": n.untrusted_flag} for n in nodes],
            "edges": [{"from": e.from_id, "to": e.to_id, "label": e.label} for e in edges],
        },
        "agent_runs": [{"id": r.id, "agent": r.agent, "status": r.status, "runner": r.runner, "mode": r.mode, "output": r.output, "error": r.error,
                        "cost_inr": r.cost_inr, "tokens": r.tokens, "evidence_version_in": r.evidence_version_in, "evidence_version_after": r.evidence_version_after,
                        "started_at": r.started_at.isoformat(), "finished_at": r.finished_at.isoformat() if r.finished_at else None} for r in runs],
        "checkpoints": [{"seq": p.seq, "from_state": p.from_state, "state": p.state, "reason": p.reason, "payload": p.payload, "evidence_version": p.evidence_version, "created_at": p.created_at.isoformat()} for p in cps],
        "proposal": _proposal_json(active) if active else None,
        "proposals": [_proposal_json(p) for p in props],
        "approvals": [cs.approval_json(a) for a in aps],
        "actions": [{"id": a.id, "type": a.type, "status": a.status, "target_system": a.target_system, "target_id": a.target_id, "idempotency_key": a.idempotency_key,
                     "request": a.request, "response": a.response, "error": a.error, "attempts": a.attempts, "created_at": a.created_at.isoformat()} for a in acts],
        "verification": {"id": ver.id, "status": ver.status, "checks": ver.checks, "read_back": ver.read_back, "created_at": ver.created_at.isoformat()} if ver else None,
        "laya": c.laya or {},
    }


def _proposal_json(p: Proposal) -> dict[str, Any]:
    return {"id": p.id, "version": p.version, "action": p.payload, "payload_hash": p.payload_hash, "claims": p.claims, "uncertainty": p.uncertainty, "risk": p.risk,
            "validation": p.validation, "evidence_version": p.evidence_version, "status": p.status, "created_by": p.created_by, "created_at": p.created_at.isoformat()}


@router.get("/cases/{case_ref}/trace")
async def case_trace(case_ref: str, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    c = await _get_case(session, user, case_ref)
    evs = (await session.execute(select(AgentEvent).where(AgentEvent.tenant_id == user.tenant_id, AgentEvent.case_id == c.id).order_by(AgentEvent.id))).scalars().all()
    calls = (await session.execute(select(ToolCall).where(ToolCall.case_id == c.id).order_by(ToolCall.created_at))).scalars().all()
    return {
        "case_id": c.id,
        "events": [{"id": e.id, "run_id": e.run_id, "agent": e.agent, "type": e.type, "data": e.data, "ts": e.ts.isoformat()} for e in evs],
        "tool_calls": [{"tool": t.tool, "agent": t.agent, "allowed": t.allowed, "ok": t.ok, "latency_ms": t.latency_ms, "args": t.args, "result": t.result_summary, "error": t.error, "run_id": t.run_id} for t in calls],
    }


@router.post("/cases/{case_ref}/resume")
async def resume_case(case_ref: str, user: User = Depends(require_role("operator")), session: AsyncSession = Depends(get_session)):
    from ..jobs import enqueue_advance

    c = await _get_case(session, user, case_ref)
    await append_audit(session, user.tenant_id, "case.resume_requested", user.email, {"state": c.state}, c.id, c.correlation_id)
    await session.commit()
    return {"enqueued": await enqueue_advance(c.id), "state": c.state}


@router.get("/media/{node_id}")
async def media(node_id: str, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    from .. import storage

    n = await session.get(EvidenceNode, node_id)
    if n is None or n.tenant_id != user.tenant_id or not n.media_object_key or not storage.tenant_owns(user.tenant_id, n.media_object_key):
        raise HTTPException(404, "not found")
    return Response(await storage.get_bytes(n.media_object_key), media_type=n.mime or "application/octet-stream")


# ------------------------------------------------------------------ approvals
class CommentBody(BaseModel):
    comment: str = ""


class ReasonBody(BaseModel):
    reason: str


class EditBody(BaseModel):
    action: dict[str, Any]
    reason: str


@router.get("/approvals")
async def list_approvals(status: Optional[str] = Query(default=None), user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    stmt = select(Approval, Case, Proposal).join(Case, Case.id == Approval.case_id).join(Proposal, Proposal.id == Approval.proposal_id).where(Approval.tenant_id == user.tenant_id)
    if status:
        sts = status.split(",")
        if "pending" in sts:
            sts.append("partially_approved")
        stmt = stmt.where(Approval.status.in_(sts))
    rows = (await session.execute(stmt.order_by(Approval.created_at.desc()))).all()
    from ..business import approval_card

    items = [{**cs.approval_json(a), "case": {"id": c.id, "case_number": c.case_number, "po_ref": c.po_ref, "customer": c.customer, "state": c.state},
              "proposal": _proposal_json(p), "card": await approval_card(session, a, c, p)} for a, c, p in rows]
    return {"approvals": items, "items": items}


def _approval_http(e: ApprovalError):
    raise HTTPException(e.status, e.message)


@router.post("/approvals/{approval_id}/approve")
async def approve_ep(approval_id: str, body: CommentBody = CommentBody(), user: User = Depends(current_user)):
    try:
        return await approve(approval_id, user, body.comment)
    except ApprovalError as e:
        _approval_http(e)


@router.post("/approvals/{approval_id}/reject")
async def reject_ep(approval_id: str, body: ReasonBody, user: User = Depends(current_user)):
    try:
        return await reject(approval_id, user, body.reason)
    except ApprovalError as e:
        _approval_http(e)


@router.post("/approvals/{approval_id}/edit")
async def edit_ep(approval_id: str, body: EditBody, user: User = Depends(current_user)):
    try:
        return await edit(approval_id, user, body.action, body.reason)
    except ApprovalError as e:
        _approval_http(e)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


# ------------------------------------------------------------------ triage queue / escalations
class LabelBody(BaseModel):
    exception_type: str
    severity: str


@router.get("/triage-queue")
async def triage_queue(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    rows = (await session.execute(select(TriageQueueItem, Case).join(Case, Case.id == TriageQueueItem.case_id).where(TriageQueueItem.tenant_id == user.tenant_id).order_by(TriageQueueItem.created_at.desc()))).all()
    return {"items": [{"id": t.id, "case_id": t.case_id, "case_number": c.case_number, "triage": t.triage, "confidence": t.confidence, "status": t.status, "label": t.label, "created_at": t.created_at.isoformat()} for t, c in rows]}


@router.post("/triage-queue/{item_id}/label")
async def label_triage(item_id: str, body: LabelBody, user: User = Depends(require_role("operator")), session: AsyncSession = Depends(get_session)):
    from ..jobs import enqueue_advance
    from ..schemas import TriageOutput

    t = await session.get(TriageQueueItem, item_id)
    if t is None or t.tenant_id != user.tenant_id:
        raise HTTPException(404, "not found")
    try:
        TriageOutput.model_validate({**(t.triage or {}), "exception_type": body.exception_type, "severity": body.severity})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, f"invalid label: {e}") from e
    c = await session.get(Case, t.case_id)
    t.status, t.label, t.labeled_by = "labeled", body.model_dump(), user.email
    c.exception_type, c.severity, c.awaiting_label = body.exception_type, body.severity, False
    await append_audit(session, user.tenant_id, "triage.labeled", user.email, body.model_dump(), c.id, c.correlation_id)
    if body.exception_type == "none":
        await cs.transition(session, c, "WATCHING", "human label: no exception", actor=user.email)
        await cs.transition(session, c, "CLOSED", "human label: no exception", actor=user.email)
    await session.commit()
    await enqueue_advance(c.id)
    return {"ok": True}


class ResolveBody(BaseModel):
    resolution: str = ""
    next_state: Optional[str] = None  # INVESTIGATING (default) | CLOSED | WATCHING


@router.get("/escalations")
async def escalations(status: Optional[str] = None, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    stmt = select(Escalation, Case).join(Case, Case.id == Escalation.case_id).where(Escalation.tenant_id == user.tenant_id)
    if status:
        stmt = stmt.where(Escalation.status == status)
    rows = (await session.execute(stmt.order_by(Escalation.created_at.desc()))).all()
    return {"escalations": [{"id": e.id, "case_id": e.case_id, "case_number": c.case_number, "reason": e.reason, "detail": e.detail, "status": e.status, "resolution": e.resolution,
                             "resolved_by": e.resolved_by, "created_at": e.created_at.isoformat()} for e, c in rows]}


@router.post("/escalations/{esc_id}/resolve")
async def resolve_escalation(esc_id: str, body: ResolveBody = ResolveBody(), user: User = Depends(require_role("operator")), session: AsyncSession = Depends(get_session)):
    from ..db import utcnow
    from ..jobs import enqueue_advance

    e = await session.get(Escalation, esc_id)
    if e is None or e.tenant_id != user.tenant_id:
        raise HTTPException(404, "not found")
    c = await session.get(Case, e.case_id)
    e.status, e.resolution, e.resolved_by, e.resolved_at = "resolved", body.resolution, user.email, utcnow()
    target = (body.next_state or "INVESTIGATING").upper()
    if c.state in ("ESCALATED", "BLOCKED"):
        try:
            await cs.transition(session, c, target, f"escalation resolved by {user.email}: {body.resolution}", actor=user.email)
        except cs.TransitionError as ex:
            raise HTTPException(409, str(ex)) from ex
        rc = dict(c.retry_counts or {})
        rc.pop("resolution_invalid", None)
        c.retry_counts = rc
    await append_audit(session, user.tenant_id, "escalation.resolved", user.email, {"escalation_id": e.id, "next_state": target, "resolution": body.resolution}, c.id, c.correlation_id)
    await session.commit()
    await enqueue_advance(c.id)
    return {"ok": True, "state": c.state}


# ------------------------------------------------------------------ audit
@router.get("/audit")
async def audit(case_id: Optional[str] = None, correlation_id: Optional[str] = None, limit: int = 500, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    stmt = select(AuditLog).where(AuditLog.tenant_id == user.tenant_id)
    if case_id:
        c = (await session.execute(select(Case.id).where(Case.tenant_id == user.tenant_id, or_(Case.id == case_id, Case.case_number == case_id)))).scalar_one_or_none()
        stmt = stmt.where(AuditLog.case_id == (c or case_id))
    if correlation_id:
        stmt = stmt.where(AuditLog.correlation_id == correlation_id)
    rows = (await session.execute(stmt.order_by(AuditLog.seq.desc()).limit(min(limit, 2000)))).scalars().all()
    return {"entries": [{"seq": r.seq, "case_id": r.case_id, "correlation_id": r.correlation_id, "actor": r.actor, "event": r.event, "data": r.data,
                         "prev_hash": r.prev_hash, "hash": r.hash, "created_at": r.created_at.isoformat()} for r in rows]}


@router.get("/audit/verify")
async def audit_verify(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await verify_chain(session, user.tenant_id)


# ------------------------------------------------------------------ metrics / eval
def _pct(vals: list[float], p: float) -> float | None:
    if not vals:
        return None
    vals = sorted(vals)
    k = max(0, min(len(vals) - 1, int(round(p * (len(vals) - 1)))))
    return round(vals[k], 2)


@router.get("/metrics/summary")
async def metrics(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    tid = user.tenant_id
    by_state = dict((await session.execute(select(Case.state, func.count()).where(Case.tenant_id == tid).group_by(Case.state))).all())
    closed = (await session.execute(select(Case).where(Case.tenant_id == tid, Case.closed_at.is_not(None)))).scalars().all()
    durations = [(c.closed_at - c.created_at).total_seconds() for c in closed if c.closed_at and c.created_at]
    acts = (await session.execute(select(Action).where(Action.tenant_id == tid))).scalars().all()
    vers = (await session.execute(select(Verification).where(Verification.tenant_id == tid))).scalars().all()
    runs = (await session.execute(select(AgentRun).where(AgentRun.tenant_id == tid))).scalars().all()
    calls = (await session.execute(select(ToolCall).where(ToolCall.tenant_id == tid))).scalars().all()
    audit_counts = dict((await session.execute(select(AuditLog.event, func.count()).where(AuditLog.tenant_id == tid).group_by(AuditLog.event))).all())
    invoice_targets = [a.target_id for a in acts if a.type == "create_invoice" and a.status == "succeeded"]
    from ..breaker import all_breakers

    return {
        "cases": {"total": sum(by_state.values()), "by_state": by_state},
        "case_duration_seconds": {"n": len(durations), "p50": _pct(durations, 0.5), "p95": _pct(durations, 0.95)},
        "actions": {"attempted": len(acts), "succeeded": sum(a.status == "succeeded" for a in acts), "failed": sum(a.status == "failed" for a in acts),
                    "duplicate_writes": len(invoice_targets) - len(set(invoice_targets))},
        "verified_resolution_rate": {"numerator": sum(v.status == "pass" for v in vers), "denominator": len({a.case_id for a in acts if a.status == "succeeded"})},
        "agent_runs": {"total": len(runs), "failed": sum(r.status == "failed" for r in runs), "cost_inr": round(sum(r.cost_inr or 0 for r in runs), 4),
                       "by_runner": {k: sum(r.runner == k for r in runs) for k in {r.runner for r in runs}}},
        "tool_calls": {"total": len(calls), "denied": sum(not c.allowed for c in calls), "errors": sum((not c.ok) and c.allowed for c in calls),
                       "connector_errors": sum(bool((c.result_summary or {}).get("connector_down")) for c in calls)},
        "guardrails": {k: audit_counts.get(k, 0) for k in ("intake.quarantined", "approval.role_blocked", "approval.expired", "gateway.duplicate_blocked", "gateway.blocked", "case.escalated", "tool.denied")},
        "breakers": all_breakers(),
    }


@router.get("/eval/latest")
async def eval_latest(user: User = Depends(current_user)):
    s = get_settings()
    for p in (Path(s.eval_results_path), Path(__file__).resolve().parents[4] / "eval" / "results" / "latest.json"):
        if p.exists():
            return json.loads(p.read_text())
    raise HTTPException(404, "no eval results yet; run `python -m eval.run` (see README)")


@router.get("/events/recent")
async def recent_events(type: Optional[str] = None, limit: int = 200, user: User = Depends(current_user)):
    """Recent server events seen by this API process (debug / UI catch-up after reconnect)."""
    from ..events import bus

    evs = [e for e in bus.recent if e.get("tenant_id") == user.tenant_id and (not type or e.get("type") == type)]
    return {"events": [{k: v for k, v in e.items() if k != "tenant_id"} for e in evs[-min(limit, 500):]]}


# ------------------------------------------------------------------ admin
class KillBody(BaseModel):
    enabled: bool


@router.post("/admin/kill-switch")
async def kill_switch(body: KillBody, user: User = Depends(require_role("admin")), session: AsyncSession = Depends(get_session)):
    await set_flag(session, user.tenant_id, KILL_SWITCH, body.enabled)
    await append_audit(session, user.tenant_id, "admin.kill_switch", user.email, {"enabled": body.enabled})
    cs.guardrail_event(session, user.tenant_id, None, "paused", {"kill_switch": body.enabled})
    await session.commit()
    if not body.enabled:
        from ..jobs import enqueue_advance

        for cid in (await session.execute(select(Case.id).where(Case.tenant_id == user.tenant_id, Case.state == "PAUSED"))).scalars().all():
            await enqueue_advance(cid)
    return {"kill_switch": body.enabled}
