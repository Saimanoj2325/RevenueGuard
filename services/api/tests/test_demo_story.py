"""End-to-end PO-184 / RG-1042 + PO-185 story through /demo/step 0..14 (web Demo Control Room numbering) over HTTP (DEMO_MODE, zero keys, builtin agent runner)."""
import asyncio

from httpx import ASGITransport, AsyncClient

from .helpers import zoho_invoices


async def test_full_demo_story(db):
    from app.events import bus
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t", timeout=120) as c:
        assert (await c.post("/demo/reset")).status_code == 200
        res = {}
        for n in range(15):
            r = await c.post(f"/demo/step/{n}")
            assert r.status_code == 200, (n, r.text)
            res[n] = r.json()
            assert res[n]["played_first"] == [], (n, res[n]["played_first"])
        d = lambda n: res[n]["detail"]  # noqa: E731
        assert d(1)["state_after"] == "WATCHING" and d(1)["intake"][0]["case_number"] == "RG-1042"
        assert d(2)["state_after"] == "WATCHING"
        assert d(3)["state_after"] == "WATCHING"
        assert d(4)["state_after"] == "EVIDENCE_READY"
        assert d(5)["state_after"] == "INVESTIGATING" and d(5)["billable"]["amount"] == 60000.0
        assert d(6)["state_after"] == "PROPOSED"
        assert d(7)["state_after"] == "AWAITING_APPROVAL"
        case = res[7]["cases"][0]
        assert case["approval"]["amount"] == 60000.0 and case["proposal"]["amount"] == 60000.0
        assert d(8)["intake"][0]["status"] == "quarantined" and d(8)["state_after"] == "AWAITING_APPROVAL"
        assert d(9)["blocked"] and d(9)["http_status"] == 403
        assert d(10)["state_after"] == "AWAITING_APPROVAL" and res[10]["cases"][0]["approval"]["amount"] == 70000.0
        assert d(11)["paused_state"] == "PAUSED"
        assert d(11)["state_after"] == "CLOSED" and res[11]["cases"][0]["verification"]["status"] == "pass"
        assert d(12)["double_execute"] == ["duplicate", "duplicate"] and d(12)["intake_replay"] == "duplicate"
        # UX v2: the approved payload carries GST lines (hash-bound); the invoice is ₹70,000 + 18% GST = ₹82,600
        assert d(12)["zoho_invoices_for_PO-184"] == [{"invoice_number": "INV-2301", "total": 82600.0}]
        assert d(13)["state_after"] == "AWAITING_APPROVAL" and res[13]["cases"][1]["approval"]["required_approvers"] == 2
        assert d(14)["approvals"] == ["partially_approved", "approved"] and d(14)["state_at_crash"] == "EXECUTING"
        assert d(14)["state_after"] == "CLOSED"
        # already-played (non-replayable) scenes are not repeated
        again = (await c.post("/demo/step/7")).json()
        assert again["detail"] == {"already_played": True}
        assert (await c.post("/demo/step/15")).status_code == 404

        tok = (await c.post("/auth/login", json={"email": "admin@demo.in", "password": "demo1234"})).json()["token"]
        H = {"Authorization": f"Bearer {tok}"}
        assert (await c.get("/audit/verify", headers=H)).json()["ok"] is True
        m = (await c.get("/metrics/summary", headers=H)).json()
        assert m["actions"]["duplicate_writes"] == 0 and m["verified_resolution_rate"] == {"numerator": 2, "denominator": 2}
        detail = (await c.get("/cases/RG-1042", headers=H)).json()
        assert detail["case"]["state"] == "CLOSED"
        assert {t["stage"]: t["status"] for t in detail["timeline"]}["invoice"] == "partial"  # 70 of 100 units invoiced
        assert any(n["quarantined"] for n in detail["evidence"]["nodes"])
        assert detail["verification"]["status"] == "pass"
        assert (await c.get("/cases/RG-1042/trace", headers=H)).json()["events"]
    await asyncio.sleep(0.05)
    assert len(await zoho_invoices(db, "PO-184")) == 1 and len(await zoho_invoices(db, "PO-185")) == 1
    kinds = {e.get("kind") for e in bus.recent if e.get("type") == "guardrail"}
    assert {"injection", "role_block", "approval_expired", "paused", "duplicate_block"} <= kinds
    providers = [e for e in bus.recent if e.get("type") == "llm.provider" and e.get("fallback")]
    assert any(e["provider"] == "groq" for e in providers)


async def test_jump_ahead_plays_missing_scenes_first(db):
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t", timeout=120) as c:
        assert (await c.post("/demo/reset")).status_code == 200
        r = (await c.post("/demo/step/7")).json()
        assert r["played_first"] == [0, 1, 2, 3, 4, 5, 6]
        assert r["detail"]["state_after"] == "AWAITING_APPROVAL" and r["cases"][0]["approval"]["amount"] == 60000.0
        assert (await c.get("/demo/status")).json()["scenes_done"] == [0, 1, 2, 3, 4, 5, 6, 7]


async def test_demo_only_helpers_mock_connect_and_speed(db):
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t", timeout=60) as c:
        assert (await c.post("/demo/reset")).status_code == 200
        tok = (await c.post("/auth/login", json={"email": "admin@demo.in", "password": "demo1234"})).json()["token"]
        H = {"Authorization": f"Bearer {tok}"}
        r = await c.post("/connectors/google/mock-connect", headers=H)
        assert r.status_code == 200 and r.json()["connected"] == ["gmail", "sheets", "drive"]
        conns = {x["name"]: x for x in (await c.get("/connectors", headers=H)).json()["connectors"]}
        assert conns["gmail"]["status"] == "connected" and conns["gmail"]["mode"] == "mock"
        ops = (await c.post("/auth/login", json={"email": "ops@demo.in", "password": "demo1234"})).json()["token"]
        assert (await c.post("/connectors/zoho/mock-connect", headers={"Authorization": f"Bearer {ops}"})).status_code == 403
        assert (await c.post("/demo/speed", json={"speed": 4})).json() == {"ok": True, "speed": 4.0}
        assert (await c.get("/demo/status")).json()["speed"] == 4.0


async def test_ws_agent_event_shape_and_case_number(db):
    from app.events import bus
    from app.routers.ws import enrich

    from .helpers import play

    await play(1)
    ev = next(e for e in reversed(bus.recent) if e.get("type") == "agent.event")
    assert set(ev["event"]) >= {"run_id", "case_id", "type", "agent", "data", "ts"} and ev["case_id"] == ev["event"]["case_id"]
    out = await enrich({k: v for k, v in ev.items() if k != "tenant_id"})
    assert out["case_number"] == "RG-1042" and out["event"]["case_number"] == "RG-1042"
