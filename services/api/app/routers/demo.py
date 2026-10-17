"""Demo endpoints (DEMO_MODE only). Fixtures go through the same intake path as live data."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config import get_settings

router = APIRouter(prefix="/demo")


def _guard():
    if not get_settings().demo_mode:
        raise HTTPException(403, "demo endpoints are only available with DEMO_MODE=true")


@router.post("/reset")
async def reset():
    _guard()
    from ..demo.scenes import reset_demo

    return await reset_demo()


@router.post("/showcase")
async def showcase():
    """Reset + business seed + play the PO-184 story to the Rs 70,000 approval and PO-185 to its two-approver approval,
    so every UX v2 screen shows the full story (see docs/CONTRACT_V2.md, Demo data)."""
    _guard()
    from ..demo.business_seed import showcase as _show

    return await _show()


@router.post("/seed-business")
async def seed_business():
    _guard()
    from ..demo.business_seed import seed_business as _seed

    return await _seed()


@router.get("/scenes")
async def scenes():
    from ..demo.scenes import SCENES

    return {"scenes": [{"n": k, "title": v} for k, v in SCENES.items()]}


@router.post("/step/{n}")
async def step(n: int):
    _guard()
    from ..demo.scenes import SCENES, play_scene

    if n not in SCENES:
        raise HTTPException(404, f"scene must be {min(SCENES)}..{max(SCENES)}")
    return await play_scene(n)


@router.get("/status")
async def status():
    _guard()
    from ..demo.scenes import DONE_FLAG
    from ..demo.seed import seed
    from ..db import session_scope
    from ..flags import get_flag

    tid = await seed()
    async with session_scope() as s:
        return {"scenes_done": list(await get_flag(s, tid, DONE_FLAG, []) or []), "speed": float(await get_flag(s, tid, "demo:speed", 1) or 1)}


class SpeedBody(BaseModel):
    speed: float = 1.0


@router.post("/speed")
async def speed(body: SpeedBody):
    """Presenter pacing knob used by the web control room. The real API has no artificial delays, so this only
    records the value (the web mock backend uses it to pace its animations)."""
    _guard()
    from ..db import session_scope
    from ..demo.seed import seed
    from ..flags import set_flag

    tid = await seed()
    sp = max(0.1, min(float(body.speed or 1), 20.0))
    async with session_scope() as s:
        await set_flag(s, tid, "demo:speed", sp)
    return {"ok": True, "speed": sp}


class ChaosBody(BaseModel):
    enabled: Optional[bool] = True


@router.post("/chaos/{kind}")
async def chaos(kind: str, body: Optional[ChaosBody] = None):
    _guard()
    from ..demo.scenes import chaos as do_chaos

    enabled = True if body is None or body.enabled is None else body.enabled
    try:
        return await do_chaos(kind, enabled)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


class FFBody(BaseModel):
    hours: float


@router.post("/fast-forward")
async def fast_forward(body: FFBody):
    _guard()
    from ..demo.scenes import fast_forward as ff

    return await ff(body.hours)
