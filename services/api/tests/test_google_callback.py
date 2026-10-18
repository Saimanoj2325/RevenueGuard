"""The Google OAuth callback never shows a bare 500: every failure goes back to the app with a reason."""
import httpx
import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client(db):
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        yield c


async def test_denied_and_missing_and_bad_state(client):
    r = await client.get("/connectors/google/callback?error=access_denied")
    assert r.status_code in (302, 307) and "google_error=" in r.headers["location"]
    r = await client.get("/connectors/google/callback")
    assert "google_error=" in r.headers["location"]
    r = await client.get("/connectors/google/callback?code=x&state=not-a-jwt")
    assert "expired" in r.headers["location"]


async def test_reused_code_redirects_with_reason(client, monkeypatch):
    from app.security import sign_state
    import app.connectors.google as g

    async def boom(code):
        req = httpx.Request("POST", "https://oauth2.googleapis.com/token")
        raise httpx.HTTPStatusError("bad", request=req, response=httpx.Response(400, json={"error": "invalid_grant"}, request=req))

    monkeypatch.setattr(g, "google_exchange_code", boom)
    st = sign_state({"tid": "t1", "uid": "u1", "email": "a@b.c", "provider": "google"})
    r = await client.get(f"/connectors/google/callback?code=used&state={st}")
    assert r.status_code in (302, 307)
    assert "/setup/connections?google_error=" in r.headers["location"] and "already%20used" in r.headers["location"]
