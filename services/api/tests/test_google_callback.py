"""The Google OAuth callback never shows a bare 500: every failure goes back to the app with a reason."""
import httpx

from app import models  # noqa: F401  (register tables before the db fixture creates them)
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

    async def boom(code, redirect_uri=None):
        req = httpx.Request("POST", "https://oauth2.googleapis.com/token")
        raise httpx.HTTPStatusError("bad", request=req, response=httpx.Response(400, json={"error": "invalid_grant"}, request=req))

    monkeypatch.setattr(g, "google_exchange_code", boom)
    st = sign_state({"tid": "t1", "uid": "u1", "email": "a@b.c", "provider": "google"})
    r = await client.get(f"/connectors/google/callback?code=used&state={st}")
    assert r.status_code in (302, 307)
    assert "/setup/connections?google_error=" in r.headers["location"] and "already%20used" in r.headers["location"]



async def _admin(client):
    r = await client.post("/auth/login", json={"email": "admin@demo.in", "password": "demo1234"})
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.mark.parametrize("provider,cid", [("google", "google_client_id"), ("zoho", "zoho_client_id")])
async def test_redirect_uri_follows_the_url_the_user_opened(client, monkeypatch, provider, cid):
    """Started on a tunnel host via the web proxy -> the provider gets that host's callback; the callback reuses it."""
    from urllib.parse import parse_qs, urlparse

    from app.config import get_settings
    from app.security import verify_state

    monkeypatch.setattr(get_settings(), cid, "cid")
    h = {**(await _admin(client)), "x-forwarded-host": "new-words-here.trycloudflare.com", "x-forwarded-proto": "https,http"}
    r = await client.get(f"/connectors/{provider}/start", headers=h)
    q = parse_qs(urlparse(r.headers["location"]).query)
    want = f"https://new-words-here.trycloudflare.com/api-backend/connectors/{provider}/callback"
    assert q["redirect_uri"] == [want]
    st = verify_state(q["state"][0])
    assert st["ru"] == want and st["wb"] == "https://new-words-here.trycloudflare.com"

    urls = (await client.get("/connectors/oauth-urls", headers=h)).json()
    assert urls[provider] == want

    # direct to the API (no proxy header): the .env value is used
    r = await client.get(f"/connectors/{provider}/start", headers=await _admin(client))
    env = getattr(get_settings(), f"{provider}_redirect_uri")
    assert parse_qs(urlparse(r.headers["location"]).query)["redirect_uri"] == [env]


async def test_zoho_reused_code_goes_back_to_the_tunnel(client, monkeypatch):
    import app.connectors.zoho as z
    from app.security import sign_state

    async def bad(code, accounts_server=None, redirect_uri=None):
        raise ValueError("invalid_code")

    monkeypatch.setattr(z, "zoho_exchange_code", bad)
    st = sign_state({"tid": "t1", "uid": "u1", "email": "a@b.c", "provider": "zoho", "ru": "https://x.trycloudflare.com/api-backend/connectors/zoho/callback", "wb": "https://x.trycloudflare.com"})
    r = await client.get(f"/connectors/zoho/callback?code=used&state={st}")
    assert r.headers["location"].startswith("https://x.trycloudflare.com/setup/connections?zoho_error=")
