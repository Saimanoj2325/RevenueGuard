"""Approval decisions (approve / reject / edit) with role checks, distinct approvers and staleness checks."""
from __future__ import annotations

from typing import Any

from sqlalchemy import select

from . import case_service as cs
from .audit import append_audit
from .db import session_scope, utcnow
from .models import Approval, Case, Proposal, User
from .security import APPROVER_ROLES, payload_hash


class ApprovalError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


async def _load(s, approval_id: str, user: User) -> tuple[Approval, Case, Proposal]:
    ap = await s.get(Approval, approval_id)
    if ap is None or ap.tenant_id != user.tenant_id:
        raise ApprovalError(404, "approval not found")
    case = await s.get(Case, ap.case_id)
    prop = await s.get(Proposal, ap.proposal_id)
    return ap, case, prop


async def _role_gate(s, ap: Approval, case: Case, user: User, verb: str) -> None:
    if user.role not in APPROVER_ROLES:
        await append_audit(s, user.tenant_id, "approval.role_blocked", user.email, {"approval_id": ap.id, "role": user.role, "verb": verb}, case.id, case.correlation_id)
        cs.guardrail_event(s, user.tenant_id, case.id, "role_block", {"user": user.email, "role": user.role, "attempted": verb, "reason": "only finance_approver or admin may decide financial actions"})
        raise ApprovalError(403, f"role '{user.role}' cannot {verb} financial actions")


async def approve(approval_id: str, user: User, comment: str = "") -> dict[str, Any]:
    blocked: ApprovalError | None = None
    async with session_scope() as s:
        ap, case, prop = await _load(s, approval_id, user)
        try:
            await _role_gate(s, ap, case, user, "approve")
        except ApprovalError as e:
            blocked = e
        if blocked is None:
            if ap.status not in ("pending", "partially_approved"):
                raise ApprovalError(409, f"approval is {ap.status}" + (f": {ap.expires_reason}" if ap.expires_reason else ""))
            if any(a["user_id"] == user.id for a in ap.approvers or []):
                await append_audit(s, user.tenant_id, "approval.double_click_ignored", user.email, {"approval_id": ap.id}, case.id, case.correlation_id)
                raise ApprovalError(409, "you have already approved this action; a second approval must come from a different person")
            if ap.evidence_version != case.evidence_version:
                await cs.expire_approvals_on_evidence_change(s, case, "evidence changed before approval")
                raise ApprovalError(409, "approval expired: evidence changed")
            if payload_hash(prop.payload) != ap.payload_hash:
                raise ApprovalError(409, "payload hash mismatch; proposal was altered")
            approvers = list(ap.approvers or []) + [{"user_id": user.id, "email": user.email, "role": user.role, "at": utcnow().isoformat(), "comment": comment}]
            ap.approvers = approvers
            ap.status = "approved" if len({a["user_id"] for a in approvers}) >= ap.required_approvers else "partially_approved"
            if ap.status == "approved":
                ap.decided_at = utcnow()
            await append_audit(s, user.tenant_id, "approval.approved" if ap.status == "approved" else "approval.partially_approved", user.email,
                               {"approval_id": ap.id, "payload_hash": ap.payload_hash, "evidence_version": ap.evidence_version, "approvers": len(approvers), "required": ap.required_approvers, "comment": comment}, case.id, case.correlation_id)
            cs.queue_event(s, user.tenant_id, {"type": "approval.updated", "approval": cs.approval_json(ap)})
            out = cs.approval_json(ap)
            case_id = case.id
    if blocked:
        raise blocked
    if out["status"] == "approved":
        from .jobs import enqueue_advance

        await enqueue_advance(case_id)
    return out


async def reject(approval_id: str, user: User, reason: str) -> dict[str, Any]:
    blocked = None
    async with session_scope() as s:
        ap, case, prop = await _load(s, approval_id, user)
        try:
            await _role_gate(s, ap, case, user, "reject")
        except ApprovalError as e:
            blocked = e
        if blocked is None:
            if ap.status not in ("pending", "partially_approved"):
                raise ApprovalError(409, f"approval is {ap.status}")
            ap.status, ap.rejected_reason, ap.decided_at = "rejected", reason, utcnow()
            prop.status = "rejected"
            from .models import Reminder

            for r in (await s.execute(select(Reminder).where(Reminder.approval_id == ap.id))).scalars().all():
                r.status = "rejected"
            await append_audit(s, user.tenant_id, "approval.rejected", user.email, {"approval_id": ap.id, "reason": reason}, case.id, case.correlation_id)
            cs.queue_event(s, user.tenant_id, {"type": "approval.updated", "approval": cs.approval_json(ap)})
            out, case_id = cs.approval_json(ap), case.id
    if blocked:
        raise blocked
    from .jobs import enqueue_advance

    await enqueue_advance(case_id)
    return out


async def edit(approval_id: str, user: User, action: dict[str, Any], reason: str) -> dict[str, Any]:
    """Human edit creates a NEW proposal version; the old approval expires and the case re-runs policy validation."""
    from .orchestrator.engine import _new_proposal
    from .schemas import ProposedAction

    action = ProposedAction.model_validate(action).model_dump()
    blocked = None
    async with session_scope() as s:
        ap, case, prop = await _load(s, approval_id, user)
        try:
            await _role_gate(s, ap, case, user, "edit")
        except ApprovalError as e:
            blocked = e
        if blocked is None:
            if ap.status not in ("pending", "partially_approved"):
                raise ApprovalError(409, f"approval is {ap.status}")
            ap.status, ap.expires_reason, ap.decided_at = "expired", f"edited by {user.email}: {reason}", utcnow()
            new = await _new_proposal(s, case, action, prop.claims, prop.uncertainty + [f"edited by {user.email}: {reason}"], prop.risk, created_by=f"user:{user.email}", validation={"edited_from_version": prop.version})
            await append_audit(s, user.tenant_id, "proposal.edited", user.email, {"approval_id": ap.id, "new_proposal_id": new.id, "reason": reason}, case.id, case.correlation_id)
            cs.queue_event(s, user.tenant_id, {"type": "approval.updated", "approval": cs.approval_json(ap)})
            if case.state == "AWAITING_APPROVAL":
                await cs.transition(s, case, "PROPOSED", f"proposal edited by {user.email}; re-validate", {"proposal_id": new.id}, actor=user.email)
            out = {"approval": cs.approval_json(ap), "new_proposal_id": new.id, "version": new.version}
            case_id = case.id
    if blocked:
        raise blocked
    from .jobs import enqueue_advance

    await enqueue_advance(case_id)
    return out
