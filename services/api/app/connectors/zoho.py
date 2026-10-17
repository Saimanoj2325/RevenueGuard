"""Live Zoho Books (India DC by default) adapter: OAuth web flow + REST v3."""
from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlencode

import httpx

from ..config import get_settings
from ..models import Connector
from ..security import decrypt_json, encrypt_json
from ..validator import refs_match
from .base import ConnectorTimeout, ConnectorUnavailable, NotConnected, ZohoAdapter

ZOHO_SCOPES = "ZohoBooks.contacts.READ,ZohoBooks.salesorders.READ,ZohoBooks.invoices.READ,ZohoBooks.invoices.CREATE,ZohoBooks.creditnotes.READ,ZohoBooks.customerpayments.READ,ZohoBooks.settings.READ"


def zoho_auth_url(state: str) -> str:
    s = get_settings()
    return f"{s.zoho_accounts_url}/oauth/v2/auth?" + urlencode(
        {"scope": ZOHO_SCOPES, "client_id": s.zoho_client_id, "response_type": "code", "redirect_uri": s.zoho_redirect_uri, "access_type": "offline", "prompt": "consent", "state": state}
    )


async def zoho_exchange_code(code: str, accounts_server: str | None = None) -> dict[str, Any]:
    s = get_settings()
    base = accounts_server or s.zoho_accounts_url
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(f"{base}/oauth/v2/token", params={"code": code, "client_id": s.zoho_client_id, "client_secret": s.zoho_client_secret, "redirect_uri": s.zoho_redirect_uri, "grant_type": "authorization_code"})
        r.raise_for_status()
        tok = r.json()
    if "error" in tok:
        raise ValueError(tok["error"])
    tok["expires_at"] = time.time() + int(tok.get("expires_in", 3600)) - 60
    tok["accounts_server"] = base
    return tok


async def zoho_list_orgs(access_token: str) -> list[dict[str, Any]]:
    s = get_settings()
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get(f"{s.zoho_api_url}/organizations", headers={"Authorization": f"Zoho-oauthtoken {access_token}"})
        r.raise_for_status()
        return r.json().get("organizations", [])


class LiveZoho(ZohoAdapter):
    def __init__(self, session, conn: Connector):
        self.session, self.conn = session, conn
        if conn.status != "connected" or not conn.auth_enc:
            raise NotConnected("zoho")
        self.org_id = (conn.config or {}).get("organization_id") or get_settings().zoho_org_id

    async def _token(self) -> str:
        tok = decrypt_json(self.conn.auth_enc)
        if tok.get("expires_at", 0) > time.time():
            return tok["access_token"]
        s = get_settings()
        base = tok.get("accounts_server") or s.zoho_accounts_url
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(f"{base}/oauth/v2/token", params={"refresh_token": tok.get("refresh_token"), "client_id": s.zoho_client_id, "client_secret": s.zoho_client_secret, "grant_type": "refresh_token"})
        data = r.json() if r.content else {}
        if r.status_code != 200 or "access_token" not in data:
            self.conn.status = "revoked"
            raise ConnectorUnavailable("zoho", f"token refresh failed: {data.get('error', r.status_code)}", retryable=False)
        tok.update(access_token=data["access_token"], expires_at=time.time() + int(data.get("expires_in", 3600)) - 60)
        self.conn.auth_enc = encrypt_json(tok)
        return tok["access_token"]

    async def _req(self, method: str, path: str, params: dict | None = None, json: Any = None, timeout: float = 20) -> dict[str, Any]:
        s = get_settings()
        token = await self._token()
        params = {**(params or {}), "organization_id": self.org_id}
        try:
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.request(method, f"{s.zoho_api_url}{path}", params=params, json=json, headers={"Authorization": f"Zoho-oauthtoken {token}"})
        except httpx.TimeoutException as e:
            raise ConnectorTimeout("zoho", str(e)) from e
        except httpx.HTTPError as e:
            raise ConnectorUnavailable("zoho", str(e)) from e
        if r.status_code >= 500 or r.status_code == 429:
            raise ConnectorUnavailable("zoho", f"HTTP {r.status_code}")
        data = r.json() if r.content else {}
        if r.status_code == 404:
            return {}
        if r.status_code >= 400 or data.get("code", 0) != 0:
            raise ConnectorUnavailable("zoho", f"API error {data.get('code')}: {data.get('message')}", retryable=False)
        return data

    async def list_contacts(self, search=None):
        return (await self._req("GET", "/contacts", {"search_text": search} if search else {})).get("contacts", [])

    async def list_salesorders(self, search=None):
        return (await self._req("GET", "/salesorders", {"search_text": search} if search else {})).get("salesorders", [])

    async def list_invoices(self, search=None, customer_id=None):
        params: dict[str, Any] = {}
        if search:
            params["search_text"] = search
        if customer_id:
            params["customer_id"] = customer_id
        return (await self._req("GET", "/invoices", params)).get("invoices", [])

    async def list_creditnotes(self, search=None):
        return (await self._req("GET", "/creditnotes", {"search_text": search} if search else {})).get("creditnotes", [])

    async def list_payments(self, search=None):
        return (await self._req("GET", "/customerpayments", {"search_text": search} if search else {})).get("customerpayments", [])

    async def find_invoices_by_reference(self, reference):
        found = (await self._req("GET", "/invoices", {"reference_number_contains": reference})).get("invoices", [])
        found += await self.list_invoices(search=reference)
        uniq = {i["invoice_id"]: i for i in found if refs_match(i.get("reference_number"), reference)}
        return list(uniq.values())

    async def create_invoice(self, payload, idempotency_key):
        body = {
            "customer_id": payload["customer_id"],
            "reference_number": payload.get("reference_number"),
            "date": payload.get("date"),
            "line_items": [{"name": li.get("name") or li.get("item"), "quantity": li["quantity"], "rate": li["rate"], **({"item_id": li["item_id"]} if li.get("item_id") else {}),
                            **({"hsn_or_sac": li["hsn_or_sac"]} if li.get("hsn_or_sac") else {}),
                            # Zoho needs an org tax_id per rate; configure connectors.zoho.config.tax_ids {"18": "<tax_id>"}
                            **({"tax_id": (self.conn.config or {}).get("tax_ids", {}).get(str(int(float(li["tax_percentage"]))))}
                               if li.get("tax_percentage") and (self.conn.config or {}).get("tax_ids", {}).get(str(int(float(li["tax_percentage"])))) else {})}
                           for li in payload["line_items"]],
            "place_of_supply": payload.get("place_of_supply"),
            "notes": (payload.get("notes", "") + f"\n[RevenueGuard key {idempotency_key[:16]}]").strip(),
        }
        body = {k: v for k, v in body.items() if v is not None}
        data = await self._req("POST", "/invoices", json=body, timeout=30)
        return data.get("invoice", {})

    async def get_invoice(self, invoice_id):
        return (await self._req("GET", f"/invoices/{invoice_id}")).get("invoice")
