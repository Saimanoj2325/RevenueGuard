"""WebSocket /ws?token= — tenant-scoped fan-out of server events (Redis pub/sub backed)."""
from __future__ import annotations

import asyncio
import json

import jwt
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..events import bus
from ..security import decode_token

router = APIRouter()
_case_numbers: dict[str, str] = {}  # case uuid -> "RG-1042" (immutable once assigned)


async def _case_number(case_id: str | None) -> str | None:
    if not case_id or not isinstance(case_id, str):
        return None
    if case_id in _case_numbers:
        return _case_numbers[case_id]
    if case_id.startswith("RG-"):
        return case_id
    try:
        from ..db import session_scope
        from ..models import Case

        async with session_scope() as s:
            c = await s.get(Case, case_id)
            if c is not None:
                _case_numbers[case_id] = c.case_number
                return c.case_number
    except Exception:  # noqa: BLE001
        return None
    return None


async def enrich(ev: dict) -> dict:
    """Add the human case number next to every case uuid so clients can match on either ("RG-1042" or uuid)."""
    if not isinstance(ev, dict):
        return ev
    if ev.get("case_id") and not ev.get("case_number"):
        n = await _case_number(ev["case_id"])
        if n:
            ev = {**ev, "case_number": n}
    inner = ev.get("event")
    if isinstance(inner, dict) and inner.get("case_id") and not inner.get("case_number"):
        n = await _case_number(inner["case_id"])
        if n:
            ev = {**ev, "event": {**inner, "case_number": n}}
    ap = ev.get("approval")
    if isinstance(ap, dict) and ap.get("case_id") and not ap.get("case_number"):
        n = await _case_number(ap["case_id"])
        if n:
            ev = {**ev, "approval": {**ap, "case_number": n}}
    return ev


@router.websocket("/ws")
async def ws(websocket: WebSocket):
    token = websocket.query_params.get("token")
    try:
        claims = decode_token(token or "")
    except jwt.PyJWTError:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    tenant_id = claims["tid"]
    q = bus.subscribe(tenant_id)
    await websocket.send_text(json.dumps({"type": "hello", "user": claims.get("email"), "role": claims.get("role")}))

    async def pump():
        while True:
            ev = await enrich(await q.get())
            await websocket.send_text(json.dumps(ev, default=str))

    async def drain():
        while True:
            msg = await websocket.receive_text()
            if msg == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

    tasks = [asyncio.create_task(pump()), asyncio.create_task(drain())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
    except WebSocketDisconnect:
        pass
    finally:
        for t in tasks:
            t.cancel()
        bus.unsubscribe(tenant_id, q)
