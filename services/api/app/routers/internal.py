"""Service-to-service endpoints (HMAC): agent events from Harness, wa-bridge events, media ingest, agent tools."""
from __future__ import annotations

import base64
import json
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import or_, select

from ..db import session_scope
from ..deps import internal_body
from ..models import AgentRun, Case
from ..observability import correlation_id_var, get_logger
from ..orchestrator.agents import record_agent_event
from ..tools.registry import ALLOW_LIST, ToolCtx, ToolDenied, dispatch

router = APIRouter()
log = get_logger("internal")


class AgentEventIn(BaseModel):
    run_id: str
    case_id: Optional[str] = None
    type: Literal["step_started", "tool_call", "tool_result", "model_call", "step_finished", "run_finished", "run_failed"]
    agent: str
    data: dict[str, Any] = Field(default_factory=dict)
    ts: Optional[Any] = None


@router.post("/internal/agent-events")
async def agent_events(body: bytes = Depends(internal_body)):
    try:
        payload = json.loads(body)
        items = payload.get("events") if isinstance(payload, dict) and "events" in payload else (payload if isinstance(payload, list) else [payload])
        events = [AgentEventIn.model_validate(x) for x in items]
    except (ValueError, ValidationError) as e:
        raise HTTPException(422, f"invalid agent event: {e}") from e
    accepted = 0
    async with session_scope() as s:
        for ev in events:
            run = await s.get(AgentRun, ev.run_id)
            if run is None:
                raise HTTPException(404, f"unknown run_id {ev.run_id}")
            if ev.agent != run.agent:
                raise HTTPException(422, "agent mismatch for run")
            await record_agent_event(s, run, ev.type, ev.data)
            accepted += 1
    return {"ok": True, "accepted": accepted}


@router.post("/internal/wa-events")
async def wa_events(body: bytes = Depends(internal_body)):
    from ..sync import default_tenant_id, handle_wa_event

    try:
        ev = json.loads(body)
    except ValueError as e:
        raise HTTPException(422, "invalid json") from e
    if not isinstance(ev, dict) or ev.get("type") not in ("qr", "connection", "message", "message_edit", "message_delete"):
        raise HTTPException(422, "type must be qr|connection|message|message_edit|message_delete")
    if ev["type"] == "message_edit" and not (isinstance(ev.get("edit"), dict) and ev["edit"].get("id") and ev["edit"].get("chat_id") and isinstance(ev["edit"].get("text"), str)):
        raise HTTPException(422, "message_edit needs edit {id, chat_id, from, ts, text}")
    if ev["type"] == "message_delete" and not (isinstance(ev.get("delete"), dict) and ev["delete"].get("id") and ev["delete"].get("chat_id")):
        raise HTTPException(422, "message_delete needs delete {id, chat_id, from, ts}")
    tid = await default_tenant_id()
    return await handle_wa_event(tid, ev)


@router.post("/internal/wa-approval-reply")
async def wa_approval_reply(body: bytes = Depends(internal_body)):
    """Approver replied 1/2/3 on WhatsApp. Verifies the short-lived token (approval_id + payload_hash + phone) and
    that the phone belongs to a finance approver, then calls the SAME approve/reject as the web."""
    from fastapi.responses import JSONResponse

    from ..notify import handle_approval_reply

    try:
        d = json.loads(body)
        phone, approval_id, choice, token = str(d["phone"]), str(d["approval_id"]), str(d["choice"]), str(d.get("token") or "")
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(422, "phone, approval_id, choice and token are required") from e
    status, out = await handle_approval_reply(phone, approval_id, choice, token)
    return JSONResponse(out, status_code=status)


class MediaIn(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    mime: str
    base64: str
    case_id: Optional[str] = None
    sidecar_text: Optional[str] = None


@router.post("/internal/ingest-media")
async def ingest_media_ep(body: bytes = Depends(internal_body)):
    from .. import case_service as cs
    from ..media import ingest_media
    from ..sync import default_tenant_id

    try:
        m = MediaIn.model_validate_json(body)
        raw = base64.b64decode(m.base64.split(",", 1)[-1])
    except (ValidationError, ValueError) as e:
        raise HTTPException(422, str(e)) from e
    tid = await default_tenant_id()
    async with session_scope() as s:
        res = await ingest_media(tid, raw, m.mime, m.filename, session=s, sidecar_text=m.sidecar_text)
        node_id = None
        if m.case_id:
            case = (await s.execute(select(Case).where(Case.tenant_id == tid, or_(Case.id == m.case_id, Case.case_number == m.case_id)))).scalar_one_or_none()
            if case:
                node, _ = await cs.add_evidence(s, case, tid, kind="document", source="media", source_id=res["object_key"], title=m.filename, fields=res["fields"],
                                                media_object_key=res["object_key"], mime=res["mime"], derived_text=res["derived_text"], actor="ingest-media")
                node_id = node.id
    return {"ok": True, "node_id": node_id, **{k: res[k] for k in ("object_key", "derived_text", "fields", "route", "provider")}}


class ToolIn(BaseModel):
    case_id: str
    correlation_id: Optional[str] = None
    args: dict[str, Any] = Field(default_factory=dict)
    run_id: Optional[str] = None


@router.post("/tools/{name}")
async def tool_ep(name: str, body: bytes = Depends(internal_body), x_rg_agent: str | None = Header(default=None), x_rg_run_id: str | None = Header(default=None)):
    if not x_rg_agent or x_rg_agent not in ALLOW_LIST:
        raise HTTPException(403, "X-RG-Agent header missing or unknown agent")
    try:
        req = ToolIn.model_validate_json(body)
    except ValidationError as e:
        raise HTTPException(422, str(e)) from e
    run_id = req.run_id or x_rg_run_id
    denied: str | None = None
    async with session_scope() as s:
        cases = (await s.execute(select(Case).where(or_(Case.id == req.case_id, Case.case_number == req.case_id)))).scalars().all()
        if len(cases) != 1:
            raise HTTPException(404 if not cases else 409, "case not found" if not cases else "ambiguous case_number; send the case UUID")
        case = cases[0]
        if run_id:
            run = await s.get(AgentRun, run_id)
            if run is None or run.case_id != case.id or run.agent != x_rg_agent:
                raise HTTPException(403, "run_id does not belong to this case/agent")
        correlation_id_var.set(req.correlation_id or case.correlation_id)
        ctx = ToolCtx(s, case, case.tenant_id, x_rg_agent, run_id, req.correlation_id or case.correlation_id)
        try:
            res = await dispatch(ctx, name, req.args)
            out = res.json()
        except ToolDenied as e:
            denied = str(e)  # commit the denial audit + tool_calls row, then 403
    if denied:
        raise HTTPException(403, denied)
    return out
