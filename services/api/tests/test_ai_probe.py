import pytest

from app import ai_probe


@pytest.mark.asyncio
async def test_probe_all_shape(monkeypatch):
    async def fake(name, status):
        return ai_probe._row(name, name.title(), "r", "m", status, 10)

    monkeypatch.setitem(ai_probe.PROBES, "nim", lambda: fake("nim", "down"))
    monkeypatch.setitem(ai_probe.PROBES, "groq", lambda: fake("groq", "working"))
    monkeypatch.setitem(ai_probe.PROBES, "ollama", lambda: fake("ollama", "not_set_up"))
    monkeypatch.setitem(ai_probe.PROBES, "laya", lambda: fake("laya", "working"))
    monkeypatch.setitem(ai_probe.PROBES, "sarvam", lambda: fake("sarvam", "working"))
    d = await ai_probe.probe_all(force=True)
    assert [m["name"] for m in d["models"]] == ai_probe.ORDER
    assert d["reader"] == "groq"
    assert "Groq" in d["summary"]


def test_slow_and_errors():
    assert ai_probe._row("nim", "N", "r", "m", "working", 9000)["status"] == "slow"
    assert "401" in ai_probe._plain_error(Exception("Error code: 401 Unauthorized"))
    assert "429" in ai_probe._plain_error(Exception("429 Too Many Requests"))


@pytest.mark.asyncio
async def test_unreachable_services_are_down(monkeypatch):
    s = ai_probe.get_settings()
    monkeypatch.setattr(s, "laya_url", "http://127.0.0.1:1")
    monkeypatch.setattr(s, "ollama_base_url", "http://127.0.0.1:1/v1")
    assert (await ai_probe.probe_laya())["status"] == "down"
    assert (await ai_probe.probe_ollama())["status"] == "down"


@pytest.mark.asyncio
async def test_endpoint_requires_login():
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        assert (await c.get("/ai/health")).status_code == 401
