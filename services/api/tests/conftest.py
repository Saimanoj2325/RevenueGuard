"""Test setup: SQLite by default (no Docker needed); set TEST_DATABASE_URL=postgresql+asyncpg://... to run on Postgres."""
from __future__ import annotations

import os
import tempfile

_tmp = tempfile.mkdtemp(prefix="rgtest-")
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL", f"sqlite+aiosqlite:///{_tmp}/test.db")
os.environ.update(
    STORAGE_BACKEND="local",
    LOCAL_STORAGE_DIR=f"{_tmp}/objects",
    DEMO_MODE="true",
    INLINE_WORKER="true",
    AGENT_RUNNER="builtin",
    LAYA_URL="http://127.0.0.1:1",
    HARNESS_URL="http://127.0.0.1:1",
    WA_BRIDGE_URL="http://127.0.0.1:1",
    REDIS_URL="redis://127.0.0.1:1/0",
    LOG_LEVEL="ERROR",
    INTERNAL_HMAC_SECRET="test-hmac-secret",
    JWT_SECRET="test-jwt-secret",
)
for k in ("NVIDIA_API_KEY", "GROQ_API_KEY", "SARVAM_API_KEY", "GOOGLE_CLIENT_ID", "ZOHO_CLIENT_ID"):
    os.environ.pop(k, None)

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402


@pytest_asyncio.fixture
async def db():
    from app import db as dbm
    from app.breaker import _registry
    from app.events import bus
    from app.llm.router import reset_llm
    from app.orchestrator import locks

    dbm.reset_engine()
    locks._local.clear()
    bus._redis_checked, bus._redis = True, None
    engine = dbm.get_engine()
    async with engine.begin() as conn:
        if engine.dialect.name == "postgresql":
            from sqlalchemy import text

            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(dbm.Base.metadata.drop_all)
        await conn.run_sync(dbm.Base.metadata.create_all)
    for b in _registry.values():
        b.reset()
    reset_llm()
    from app.demo.fixtures import ensure_fixtures
    from app.demo.seed import seed

    ensure_fixtures()
    tid = await seed()
    yield tid
    await engine.dispose()
    dbm.reset_engine()


@pytest.fixture
def anyio_backend():
    return "asyncio"
