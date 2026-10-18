"""Work out the public URL the user actually opened the app on (localhost, a Cloudflare/ngrok tunnel, a real domain).

OAuth start requests arrive through the web app's /api-backend proxy, which forwards the browser's host in
X-Forwarded-Host. From that we build the redirect URI and the "back to the app" URL, so a new tunnel URL needs
no .env edit. Setting PUBLIC_WEB_URL pins it instead. The chosen URLs ride in the signed OAuth state, so the
callback uses exactly the same redirect URI for the token exchange.
"""
from __future__ import annotations

import re

from fastapi import Request

from .config import get_settings

PROXY_PREFIX = "/api-backend"
_HOST_RE = re.compile(r"^[A-Za-z0-9.-]+(:\d{1,5})?$")


def _first(v: str | None) -> str:
    return (v or "").split(",")[0].strip()


def web_origin(request: Request | None) -> str | None:
    """The browser-facing origin (https://abc.trycloudflare.com), or None when the request did not come via the web proxy."""
    s = get_settings()
    pinned = (getattr(s, "public_web_url", "") or "").rstrip("/")
    if pinned:
        return pinned
    if request is None:
        return None
    host = _first(request.headers.get("x-forwarded-host"))
    if not host or not _HOST_RE.match(host):
        return None
    proto = _first(request.headers.get("x-forwarded-proto")).lower()
    local = host.split(":")[0] in ("localhost", "127.0.0.1")
    if proto not in ("http", "https") or (proto == "http" and not local):
        proto = "http" if local else "https"  # tunnels and real domains are https
    return f"{proto}://{host}"


def oauth_urls(request: Request | None, provider: str) -> tuple[str, str]:
    """(redirect_uri, web_url) for this sign-in. Falls back to the .env values when the origin is unknown."""
    s = get_settings()
    origin = web_origin(request)
    env_redirect = s.google_redirect_uri if provider == "google" else s.zoho_redirect_uri
    if not origin:
        return env_redirect, s.web_url.rstrip("/")
    return f"{origin}{PROXY_PREFIX}/connectors/{provider}/callback", origin
