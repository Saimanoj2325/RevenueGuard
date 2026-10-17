"""RevenueGuard AI API (FastAPI)."""
from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import get_settings
from .events import bus
from .observability import configure_logging, correlation_id_var, get_logger, setup_otel

configure_logging(get_settings().log_level)
log = get_logger("api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    from .db import create_all
    from .demo.fixtures import ensure_fixtures
    from .demo.seed import seed

    if s.is_sqlite:
        await create_all()  # SQLite dev/test path; Postgres uses `alembic upgrade head`
    try:
        ensure_fixtures()
    except Exception as e:  # noqa: BLE001
        log.warning("fixtures.failed", error=str(e))
    tid = await seed()
    if s.demo_mode and (s.demo_business_seed or s.demo_showcase_on_start):
        try:
            from sqlalchemy import select as _sel

            from .db import session_scope
            from .models import Case

            async with session_scope() as ss:
                empty = (await ss.execute(_sel(Case.id).where(Case.tenant_id == tid).limit(1))).first() is None
            if empty and s.demo_showcase_on_start:
                from .demo.business_seed import showcase

                await showcase()
            elif empty:
                from .demo.business_seed import seed_business

                await seed_business(tid)
        except Exception as e:  # noqa: BLE001
            log.warning("demo.business_seed_failed", error=str(e))
    await bus.start_listener()
    bg: list[asyncio.Task] = []
    if s.inline_worker:
        from .worker import inline_loops

        bg.append(asyncio.create_task(inline_loops()))
    log.info("api.started", demo_mode=s.demo_mode, inline_worker=s.inline_worker, db="sqlite" if s.is_sqlite else "postgres")
    yield
    for t in bg:
        t.cancel()
    await bus.stop()


app = FastAPI(title="RevenueGuard AI API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
setup_otel(app)


@app.middleware("http")
async def correlation_mw(request: Request, call_next):
    cid = request.headers.get("X-Correlation-Id") or str(uuid.uuid4())
    correlation_id_var.set(cid)
    try:
        resp = await call_next(request)
    except Exception:  # noqa: BLE001
        log.exception("api.unhandled", path=request.url.path)
        resp = JSONResponse({"detail": "internal error", "correlation_id": cid}, status_code=500)
    resp.headers["X-Correlation-Id"] = cid
    return resp


@app.get("/health")
async def health():
    from .breaker import all_breakers

    from .llm.router import get_llm

    return {"ok": True, "demo_mode": get_settings().demo_mode, "breakers": all_breakers(), "ai": get_llm().ai_health()}


from .routers import business, connectors, core, demo, internal, ws  # noqa: E402

app.include_router(core.router)
app.include_router(business.router)
app.include_router(connectors.router)
app.include_router(internal.router)
app.include_router(demo.router)
app.include_router(ws.router)
