"""Agent execution: Harness (primary, POST /agents/run + /internal/agent-events stream) or the clearly
labelled built-in Python fallback runner (DEMO_MODE when Harness is unreachable, or AGENT_RUNNER=builtin)."""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
from pydantic import ValidationError
from sqlalchemy import select

from .. import case_service as cs
from ..config import get_settings
from ..db import session_scope, utcnow
from ..flags import chaos_on, set_flag
from ..models import AgentEvent, AgentRun, Case, ToolCall
from ..observability import get_logger
from ..schemas import AGENT_SCHEMAS
from ..security import sign_headers
from ..tools.registry import ToolCtx, ToolDenied, dispatch

log = get_logger("agents")
BUILTIN_RUNNER = "builtin-python-fallback"
HARNESS_RUNNER = "harness"

_harness_health: dict[str, Any] = {"ok": None, "checked": 0.0}


@dataclass
class AgentOutcome:
    ok: bool
    run_id: str
    agent: str
    output: dict[str, Any] | None = None
    error: str | None = None
    runner: str = BUILTIN_RUNNER
    reused: bool = False
    connector_down: str | None = None


# ------------------------------------------------------------------ events (shared by HTTP ingest + builtin)
async def record_agent_event(session, run: AgentRun, type_: str, data: dict[str, Any] | None = None) -> AgentEvent:
    data = data or {}
    ev = AgentEvent(tenant_id=run.tenant_id, run_id=run.id, case_id=run.case_id, type=type_, agent=run.agent, data=data)
    session.add(ev)
    if type_ == "model_call":
        run.cost_inr = float(run.cost_inr or 0) + float(data.get("cost_inr") or 0)
        run.tokens = int(run.tokens or 0) + int(data.get("tokens") or 0)
    if type_ == "run_finished" and run.status == "running":
        out = data.get("output")
        schema = AGENT_SCHEMAS.get(run.agent)
        try:
            if schema is None or out is None:
                raise ValueError("missing output")
            run.output = schema.model_validate(out).model_dump()
            run.status = "finished"
        except (ValidationError, ValueError) as e:
            run.status = "failed"
            run.error = f"invalid_output: {str(e)[:300]}"
        run.finished_at = utcnow()
    elif type_ == "run_failed" and run.status == "running":
        run.status = "failed"
        run.error = str(data.get("reason") or data.get("error") or "run_failed")[:500]
        run.finished_at = utcnow()
    # WS shape (CONTRACT §WebSocket): {type:"agent.event", case_id, event:{run_id, case_id, type, agent, data, ts}}
    cs.queue_event(session, run.tenant_id, {"type": "agent.event", "case_id": run.case_id,
                                            "event": {"run_id": run.id, "case_id": run.case_id, "type": type_, "agent": run.agent, "data": _trim(data), "ts": utcnow().isoformat()}})
    await session.flush()
    return ev


def _trim(d: Any, n: int = 1500) -> Any:
    s = json.dumps(d, default=str)
    return d if len(s) <= n else {"truncated": s[:n]}


# ------------------------------------------------------------------ runner selection
async def harness_available() -> bool:
    now = time.monotonic()
    if _harness_health["ok"] is not None and now - _harness_health["checked"] < 20:
        return bool(_harness_health["ok"])
    ok = False
    try:
        async with httpx.AsyncClient(timeout=1.5, trust_env=False) as c:
            r = await c.get(f"{get_settings().harness_url}/health")
            ok = r.status_code == 200
    except httpx.HTTPError:
        ok = False
    _harness_health.update(ok=ok, checked=now)
    return ok


async def choose_runner(agent: str | None = None) -> str:
    s = get_settings()
    if s.agent_runner == "builtin":
        return BUILTIN_RUNNER
    if s.agent_runner == "harness":
        return HARNESS_RUNNER
    if await harness_available():
        return HARNESS_RUNNER
    if s.demo_mode or agent == "timeline":
        return BUILTIN_RUNNER  # the timeline agent's built-in loop calls the LLM with tools (never rules in live mode)
    return HARNESS_RUNNER  # will fail -> case PAUSED (agent runtime unavailable)


# ------------------------------------------------------------------ main entry
async def run_agent(case_id: str, agent: str, mode: str = "adaptive", extra_input: dict[str, Any] | None = None) -> AgentOutcome:
    """extra_input: merged into the snapshot (the timeline agent gets its trigger event here); such runs are never reused."""
    s = get_settings()
    async with session_scope() as session:
        case = await session.get(Case, case_id)
        # resume without repeating completed work: reuse a finished run on identical evidence
        prev = (
            await session.execute(
                select(AgentRun).where(AgentRun.case_id == case_id, AgentRun.agent == agent, AgentRun.status == "finished", AgentRun.mode == mode)
                .order_by(AgentRun.started_at.desc()).limit(1)
            )
        ).scalar_one_or_none()
        if (extra_input is None and prev is not None and case.evidence_version in (prev.evidence_version_in, prev.evidence_version_after)
                and prev.input.get("case", {}).get("state") == case.state):
            return AgentOutcome(True, prev.id, agent, prev.output, runner=prev.runner, reused=True)
        snap = await cs.snapshot(session, case)
        if extra_input:
            snap = {**snap, **extra_input}
        # the one-shot chaos flag is for the case agents; the timeline agent (runs at intake) must not eat it
        garbage = agent != "timeline" and await chaos_on(session, case.tenant_id, "garbage_output")
        if garbage:
            await set_flag(session, case.tenant_id, "chaos:garbage_output", False)  # one-shot
        runner = await choose_runner(agent)
        budget = {"max_steps": s.agent_max_steps, "max_tokens": s.agent_max_tokens, "max_seconds": s.agent_max_seconds, "max_cost_inr": s.agent_max_cost_inr}
        run = AgentRun(tenant_id=case.tenant_id, case_id=case.id, agent=agent, runner=runner, correlation_id=case.correlation_id, input=snap,
                       budget=budget, evidence_version_in=case.evidence_version, mode=mode)
        session.add(run)
        used = dict(case.budget_used or {})
        # the timeline agent runs on every message: counted on its own, not against the case's investigation budget
        run_key = "timeline_runs" if agent == "timeline" else "agent_runs"
        used[run_key] = int(used.get(run_key, 0)) + 1
        case.budget_used = used
        await session.flush()
        run_id, tenant_id, corr, case_number = run.id, case.tenant_id, case.correlation_id, case.case_number
        await record_agent_event(session, run, "step_started", {"runner": runner, "mode": mode, "evidence_version": case.evidence_version})

    if runner == HARNESS_RUNNER:
        outcome = await _run_harness(run_id, case_id, case_number, corr, agent, snap, budget, garbage)
        if not outcome.ok and (outcome.error or "").startswith("harness_unavailable"):
            _harness_health.update(ok=False, checked=time.monotonic())
            if s.agent_runner == "auto" and (s.demo_mode or agent == "timeline"):
                log.warning("agents.harness_failed_fallback_builtin", agent=agent, case_id=case_id)
                return await run_agent(case_id, agent, mode, extra_input)
    else:
        from .builtin_agents import run_builtin

        outcome = await run_builtin(run_id, case_id, tenant_id, corr, agent, snap, budget, garbage, mode)

    async with session_scope() as session:
        run = await session.get(AgentRun, run_id)
        case = await session.get(Case, case_id)
        run.evidence_version_after = case.evidence_version
        used = dict(case.budget_used or {})
        cost_key = "timeline_cost_inr" if agent == "timeline" else "cost_inr"
        used[cost_key] = round(float(used.get(cost_key, 0)) + float(run.cost_inr or 0), 4)
        case.budget_used = used
        calls = (await session.execute(select(ToolCall).where(ToolCall.run_id == run_id))).scalars().all()
        down = next((c.result_summary.get("connector_down") for c in calls if (c.result_summary or {}).get("connector_down")), None)
        outcome.connector_down = down
        outcome.ok = run.status == "finished"
        outcome.output = run.output
        outcome.error = run.error
    return outcome


async def _run_harness(run_id, case_id, case_number, corr, agent, snap, budget, garbage) -> AgentOutcome:
    s = get_settings()
    body = {
        "run_id": run_id, "case_id": case_id, "case_number": case_number, "correlation_id": corr, "agent": agent, "input": snap, "budget": budget,
        "tools_base_url": f"{s.internal_api_url.rstrip('/')}/tools",
        "events_url": f"{s.internal_api_url.rstrip('/')}/internal/agent-events",
    }
    if garbage:  # harness mock-llm honours input._mock.garbage_outputs (invalid final answers -> repair -> invalid_output)
        body["input"] = {**snap, "_mock": {"garbage_outputs": 3}}
    raw = json.dumps(body, default=str).encode()
    try:
        async with httpx.AsyncClient(timeout=budget["max_seconds"] + 15, trust_env=False) as c:
            r = await c.post(f"{s.harness_url}/agents/run", content=raw, headers=sign_headers(raw, agent))
        if r.status_code >= 400:
            raise httpx.HTTPStatusError(f"harness HTTP {r.status_code}: {r.text[:200]}", request=r.request, response=r)
        data = r.json() if r.content else {}
        # synchronous mode: harness may return the final output directly
        if isinstance(data, dict) and (data.get("output") is not None or data.get("status") in ("failed", "run_failed")):
            async with session_scope() as session:
                run = await session.get(AgentRun, run_id)
                if run.status == "running":
                    if data.get("output") is not None and data.get("status") not in ("failed", "run_failed"):
                        await record_agent_event(session, run, "run_finished", {"output": data["output"], "via": "sync_response"})
                    else:
                        await record_agent_event(session, run, "run_failed", {"reason": data.get("reason") or "error", "via": "sync_response"})
                if data.get("usage"):
                    run.cost_inr = float(data["usage"].get("cost_inr") or run.cost_inr or 0)
                    run.tokens = int(data["usage"].get("tokens") or data["usage"].get("total_tokens") or run.tokens or 0)
    except httpx.HTTPError as e:
        async with session_scope() as session:
            run = await session.get(AgentRun, run_id)
            if run.status == "running":
                await record_agent_event(session, run, "run_failed", {"reason": f"harness_unavailable: {str(e)[:200]}"})
        return AgentOutcome(False, run_id, agent, error="harness_unavailable", runner=HARNESS_RUNNER)
    deadline = time.monotonic() + budget["max_seconds"] + 15
    while time.monotonic() < deadline:
        async with session_scope() as session:
            run = await session.get(AgentRun, run_id)
            if run.status != "running":
                return AgentOutcome(run.status == "finished", run_id, agent, run.output, run.error, HARNESS_RUNNER)
        await asyncio.sleep(0.3)
    async with session_scope() as session:
        run = await session.get(AgentRun, run_id)
        if run.status == "running":
            await record_agent_event(session, run, "run_failed", {"reason": "budget: max_seconds exceeded"})
    return AgentOutcome(False, run_id, agent, error="timeout", runner=HARNESS_RUNNER)


# ------------------------------------------------------------------ builtin context
@dataclass
class BuiltinCtx:
    run_id: str
    case_id: str
    tenant_id: str
    correlation_id: str
    agent: str
    snapshot: dict[str, Any]
    budget: dict[str, Any]
    steps: int = 0
    log: list[dict[str, Any]] = field(default_factory=list)

    @property
    def steps_left(self) -> int:
        return int(self.budget.get("max_steps", 8)) - self.steps

    async def emit(self, type_: str, data: dict[str, Any] | None = None) -> None:
        async with session_scope() as session:
            run = await session.get(AgentRun, self.run_id)
            await record_agent_event(session, run, type_, data or {})

    async def call_tool(self, name: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        self.steps += 1
        args = args or {}
        await self.emit("tool_call", {"tool": name, "args": args})
        try:
            async with session_scope() as session:
                case = await session.get(Case, self.case_id)
                res = await dispatch(ToolCtx(session, case, self.tenant_id, self.agent, self.run_id, self.correlation_id), name, args)
                out = res.json()
        except ToolDenied as e:
            out = {"ok": False, "error": str(e), "denied": True}
        await self.emit("tool_result", {"tool": name, "ok": out.get("ok"), "evidence_node_ids": out.get("evidence_node_ids", []), "error": out.get("error"), "connector_down": out.get("connector_down")})
        self.log.append({"tool": name, "args": args, "result": out})
        return out

    async def refresh(self) -> dict[str, Any]:
        async with session_scope() as session:
            case = await session.get(Case, self.case_id)
            self.snapshot = await cs.snapshot(session, case)
        return self.snapshot
