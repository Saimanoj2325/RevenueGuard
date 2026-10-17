"""WhatsApp via the Baileys wa-bridge service (HTTP, HMAC-signed writes)."""
from __future__ import annotations

import json
from typing import Any

import httpx

from ..config import get_settings
from ..security import sign_headers
from .base import ConnectorError, ConnectorTimeout, ConnectorUnavailable, WhatsAppAdapter


class BridgeWhatsApp(WhatsAppAdapter):
    def __init__(self, session, conn, tenant_id: str):
        self.session, self.conn, self.tenant_id = session, conn, tenant_id
        self.base = get_settings().wa_bridge_url

    async def search(self, q=None, chat=None, since=None):
        params = {k: v for k, v in {"q": q, "chat": chat, "since": since}.items() if v}
        try:
            async with httpx.AsyncClient(timeout=10, trust_env=False) as c:
                r = await c.get(f"{self.base}/messages/search", params=params)
                r.raise_for_status()
                data = r.json()
        except httpx.HTTPError as e:
            raise ConnectorUnavailable("whatsapp", f"bridge search failed: {e}") from e
        return data.get("messages", data if isinstance(data, list) else [])

    async def send(self, to, text, idempotency_key, approval_id):
        body = json.dumps({"to": to, "text": text, "idempotency_key": idempotency_key, "approval_id": approval_id}).encode()
        try:
            async with httpx.AsyncClient(timeout=20, trust_env=False) as c:
                r = await c.post(f"{self.base}/send", content=body, headers=sign_headers(body))
        except httpx.TimeoutException as e:
            raise ConnectorTimeout("whatsapp", str(e)) from e
        except httpx.HTTPError as e:
            raise ConnectorUnavailable("whatsapp", str(e)) from e
        try:
            data: dict[str, Any] = r.json() if r.content else {}
        except ValueError:
            data = {}
        if r.status_code == 409:
            # The bridge refuses a repeated idempotency key. Only status "sent" means the message went out; a key
            # left "pending"/"failed" by an earlier attempt has an UNKNOWN outcome (it may or may not have reached
            # WhatsApp) and must never be reported as delivered nor blindly re-sent under a new key.
            if data.get("status") == "sent":
                return data.get("message_id") or f"bridge-dedup:{idempotency_key[:16]}"
            raise ConnectorError("whatsapp", f"idempotency key already used with status {data.get('status')!r}: outcome unknown, manual check required", retryable=False)
        if r.status_code >= 400 or not data.get("ok"):
            raise ConnectorUnavailable("whatsapp", f"send failed: {r.status_code} {data}")
        return data.get("message_id") or f"bridge:{idempotency_key[:16]}"

    async def lookup_send(self, idempotency_key: str) -> dict[str, Any] | None:
        body = json.dumps({"idempotency_key": idempotency_key}).encode()
        try:
            async with httpx.AsyncClient(timeout=10, trust_env=False) as c:
                r = await c.post(f"{self.base}/idempotency/lookup", content=body, headers=sign_headers(body))
        except httpx.HTTPError as e:
            raise ConnectorUnavailable("whatsapp", f"idempotency read-check failed: {e}") from e
        if r.status_code == 404:
            return None
        if r.status_code >= 400:
            raise ConnectorUnavailable("whatsapp", f"idempotency read-check failed: HTTP {r.status_code}")
        data = r.json()
        return data if data.get("found") else None

    async def status(self):
        try:
            async with httpx.AsyncClient(timeout=5, trust_env=False) as c:
                r = await c.get(f"{self.base}/status")
                return r.json()
        except httpx.HTTPError as e:
            return {"state": "disconnected", "error": str(e)}

    async def qr(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=5, trust_env=False) as c:
                r = await c.get(f"{self.base}/qr")
                return r.json()
        except httpx.HTTPError as e:
            return {"qr": None, "error": str(e)}
