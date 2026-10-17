from __future__ import annotations

from sqlalchemy import select

from app.db import session_scope
from app.models import Action, AgentRun, Approval, Case, Proposal, User


async def user(email: str) -> User:
    async with session_scope() as s:
        return (await s.execute(select(User).where(User.email == email))).scalar_one()


async def case_by_ref(ref: str = "PO-184") -> Case:
    from app.validator import normalize_ref

    async with session_scope() as s:
        return (await s.execute(select(Case).where(Case.po_ref_norm == normalize_ref(ref)).order_by(Case.created_at.desc()))).scalars().first()


async def latest_approval(case_id: str) -> Approval:
    async with session_scope() as s:
        return (await s.execute(select(Approval).where(Approval.case_id == case_id).order_by(Approval.created_at.desc()))).scalars().first()


async def approvals(case_id: str) -> list[Approval]:
    async with session_scope() as s:
        return list((await s.execute(select(Approval).where(Approval.case_id == case_id).order_by(Approval.created_at))).scalars().all())


async def actions(case_id: str) -> list[Action]:
    async with session_scope() as s:
        return list((await s.execute(select(Action).where(Action.case_id == case_id))).scalars().all())


async def runs(case_id: str, agent: str | None = None) -> list[AgentRun]:
    async with session_scope() as s:
        q = select(AgentRun).where(AgentRun.case_id == case_id)
        if agent:
            q = q.where(AgentRun.agent == agent)
        return list((await s.execute(q)).scalars().all())


async def zoho_invoices(tid: str, ref: str) -> list[dict]:
    from app.connectors.registry import adapter

    async with session_scope() as s:
        return await (await adapter(s, tid, "zoho")).find_invoices_by_reference(ref)


async def play(*scenes: int) -> list[dict]:
    from app.demo.scenes import play_scene

    return [await play_scene(n) for n in scenes]


class suppress:
    """Stop background inline advancing; tests drive cases explicitly."""

    async def __aenter__(self):
        from app import jobs

        jobs.SUPPRESS["depth"] += 1

    async def __aexit__(self, *a):
        from app import jobs

        jobs.SUPPRESS["depth"] -= 1
