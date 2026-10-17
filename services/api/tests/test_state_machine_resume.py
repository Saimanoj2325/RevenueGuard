import pytest
from sqlalchemy import select

from app import case_service as cs
from app.db import session_scope
from app.flags import set_flag
from app.models import Case, CaseCheckpoint, Escalation
from app.orchestrator.engine import WorkerKilled, drive_case, resume_all

from .helpers import case_by_ref, play, runs


async def _checkpoints(case_id):
    async with session_scope() as s:
        return list((await s.execute(select(CaseCheckpoint).where(CaseCheckpoint.case_id == case_id).order_by(CaseCheckpoint.seq))).scalars().all())


async def test_crash_after_checkpoint_resumes_without_repeating_work(db):
    await play(0)
    async with session_scope() as s:
        await set_flag(s, db, "chaos:kill_worker", True)
    with pytest.raises(WorkerKilled):
        await play(1)
    case = await case_by_ref()
    cps = await _checkpoints(case.id)
    assert [c.state for c in cps] == ["INTAKE", "TRIAGED"] and case.state == "TRIAGED"
    info = await resume_all(db)
    mine = next(i for i in info if i["case_id"] == case.id)
    assert mine["from_checkpoint_seq"] == 2 and mine["final_state"] == "WATCHING"
    assert len(await runs(case.id, "triage")) == 1  # triage not repeated after the crash
    cps = await _checkpoints(case.id)
    assert [c.seq for c in cps] == list(range(1, len(cps) + 1))  # gap-free checkpoint sequence


async def test_finished_agent_run_on_same_evidence_is_reused(db):
    from app.orchestrator.agents import run_agent

    await play(2)  # RG-1042 triaged + evidence sweep (WATCHING)
    case = await case_by_ref()
    before = len(await runs(case.id))
    out = await run_agent(case.id, "evidence")
    assert out.ok and out.reused and len(await runs(case.id)) == before


async def test_illegal_transition_rejected(db):
    await play(2)  # RG-1042 triaged + evidence sweep (WATCHING)
    case = await case_by_ref()
    async with session_scope() as s:
        c = await s.get(Case, case.id)
        with pytest.raises(cs.TransitionError):
            await cs.transition(s, c, "EXECUTING", "skip approval")


async def test_invalid_agent_output_escalates_after_two_retries(db):
    await play(0)
    async with session_scope() as s:
        await set_flag(s, db, "chaos:garbage_output", True)
    await play(1)
    case = await case_by_ref()
    assert case.state == "ESCALATED"
    triage = await runs(case.id, "triage")
    assert len(triage) == 1 and triage[0].status == "failed" and triage[0].error == "invalid_output"
    async with session_scope() as s:
        esc = (await s.execute(select(Escalation).where(Escalation.case_id == case.id))).scalar_one()
    assert esc.reason == "invalid_output"
    # model-attempt events: 3 attempts (initial + 2 retries)
    from app.models import AgentEvent

    async with session_scope() as s:
        attempts = (await s.execute(select(AgentEvent).where(AgentEvent.run_id == triage[0].id, AgentEvent.type == "model_call"))).scalars().all()
    assert len(attempts) == 3


async def test_connector_down_pauses_then_resumes(db):
    await play(0)
    async with session_scope() as s:
        await set_flag(s, db, "chaos:zoho_down", True)
    await play(2)  # evidence sweep hits Zoho
    case = await case_by_ref()
    assert case.state == "PAUSED" and case.paused_reason.startswith("connector:zoho")
    assert await drive_case(case.id) == "PAUSED"  # still down: stays paused, no hot loop
    async with session_scope() as s:
        await set_flag(s, db, "chaos:zoho_down", False)
    assert await drive_case(case.id) == "WATCHING"


async def test_case_budget_escalates(db, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "case_budget_max_agent_runs", 1)
    await play(2)  # RG-1042 triaged + evidence sweep (WATCHING)
    case = await case_by_ref()
    assert case.state == "ESCALATED" and "budget" in (case.escalation_reason or "")
