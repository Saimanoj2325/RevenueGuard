"""Live Google adapters (Gmail / Sheets / Drive) over REST with OAuth web-flow tokens (encrypted at rest)."""
from __future__ import annotations

import base64
import re
import time
from email.message import EmailMessage
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlencode

import httpx

from ..config import get_settings
from ..models import Connector
from ..security import decrypt_json, encrypt_json
from .base import ConnectorError, ConnectorTimeout, ConnectorUnavailable, DriveAdapter, GmailAdapter, NotConnected, SheetsAdapter

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
]
GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"


def google_auth_url(state: str, redirect_uri: str | None = None) -> str:
    s = get_settings()
    return GOOGLE_AUTH_URL + "?" + urlencode(
        {
            "client_id": s.google_client_id,
            "redirect_uri": redirect_uri or s.google_redirect_uri,
            "response_type": "code",
            "scope": " ".join(GOOGLE_SCOPES),
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
            "state": state,
        }
    )


async def google_exchange_code(code: str, redirect_uri: str | None = None) -> dict[str, Any]:
    s = get_settings()
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(
            GOOGLE_TOKEN_URL,
            data={"code": code, "client_id": s.google_client_id, "client_secret": s.google_client_secret, "redirect_uri": redirect_uri or s.google_redirect_uri, "grant_type": "authorization_code"},
        )
        r.raise_for_status()
        tok = r.json()
    tok["expires_at"] = time.time() + int(tok.get("expires_in", 3600)) - 60
    return tok


async def google_revoke(conn: Connector) -> None:
    tok = decrypt_json(conn.auth_enc)
    t = tok.get("refresh_token") or tok.get("access_token")
    if t:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post("https://oauth2.googleapis.com/revoke", params={"token": t})


class _GoogleBase:
    name = "google"

    def __init__(self, session, conn: Connector):
        self.session, self.conn = session, conn
        if conn.status != "connected" or not conn.auth_enc:
            raise NotConnected(conn.name)

    async def _token(self) -> str:
        tok = decrypt_json(self.conn.auth_enc)
        if tok.get("expires_at", 0) > time.time() and tok.get("access_token"):
            return tok["access_token"]
        if not tok.get("refresh_token"):
            raise ConnectorUnavailable(self.conn.name, "token expired and no refresh token; reconnect", retryable=False)
        s = get_settings()
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(GOOGLE_TOKEN_URL, data={"client_id": s.google_client_id, "client_secret": s.google_client_secret, "refresh_token": tok["refresh_token"], "grant_type": "refresh_token"})
        if r.status_code in (400, 401):
            self.conn.status = "revoked"
            raise ConnectorUnavailable(self.conn.name, "refresh failed (revoked?)", retryable=False)
        r.raise_for_status()
        new = r.json()
        tok.update(access_token=new["access_token"], expires_at=time.time() + int(new.get("expires_in", 3600)) - 60)
        self.conn.auth_enc = encrypt_json(tok)
        return tok["access_token"]

    async def _req(self, method: str, url: str, **kw) -> Any:
        token = await self._token()
        try:
            async with httpx.AsyncClient(timeout=25) as c:
                r = await c.request(method, url, headers={"Authorization": f"Bearer {token}"}, **kw)
        except httpx.TimeoutException as e:
            raise ConnectorTimeout(self.conn.name, str(e)) from e
        except httpx.HTTPError as e:
            raise ConnectorUnavailable(self.conn.name, str(e)) from e
        if r.status_code == 401:
            raise ConnectorUnavailable(self.conn.name, "unauthorized", retryable=False)
        if r.status_code == 404:
            return None
        if r.status_code >= 500 or r.status_code == 429:
            raise ConnectorUnavailable(self.conn.name, f"HTTP {r.status_code}")
        if r.status_code >= 400:
            # 400 (bad tab/range) and 403 (no access / API not enabled) carry a plain message from Google
            try:
                msg = (r.json().get("error") or {}).get("message") or r.text
            except Exception:  # noqa: BLE001
                msg = r.text
            raise ConnectorError(self.conn.name, f"HTTP {r.status_code}: {str(msg)[:200]}", retryable=False)
        return r.json() if r.content else {}


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _walk_parts(part: dict[str, Any], out_text: list[str], out_html: list[str], atts: list[dict[str, Any]]):
    mime = part.get("mimeType", "")
    body = part.get("body", {})
    if part.get("filename") and body.get("attachmentId"):
        atts.append({"filename": part["filename"], "mime": mime, "attachment_id": body["attachmentId"], "size": body.get("size", 0)})
    elif mime == "text/plain" and body.get("data"):
        out_text.append(_b64d(body["data"]).decode("utf-8", "replace"))
    elif mime == "text/html" and body.get("data"):
        out_html.append(_b64d(body["data"]).decode("utf-8", "replace"))
    for p in part.get("parts", []) or []:
        _walk_parts(p, out_text, out_html, atts)


class LiveGmail(_GoogleBase, GmailAdapter):
    MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024

    async def _get_message(self, mid: str) -> dict[str, Any] | None:
        m = await self._req("GET", f"{GMAIL}/messages/{mid}", params={"format": "full"})
        if not m:
            return None
        headers = {h["name"].lower(): h["value"] for h in m.get("payload", {}).get("headers", [])}
        text, html, atts = [], [], []
        _walk_parts(m.get("payload", {}), text, html, atts)
        body = "\n".join(text) or re.sub(r"<[^>]+>", " ", "\n".join(html))
        for a in atts:
            if a["size"] and a["size"] <= self.MAX_ATTACHMENT_BYTES:
                data = await self._req("GET", f"{GMAIL}/messages/{mid}/attachments/{a['attachment_id']}")
                if data and data.get("data"):
                    a["data"] = _b64d(data["data"])
        try:
            date = parsedate_to_datetime(headers.get("date")).isoformat() if headers.get("date") else None
        except (TypeError, ValueError):
            date = None
        return {
            "id": m["id"],
            "thread_id": m.get("threadId"),
            "history_id": int(m.get("historyId", 0)),
            "from": headers.get("from", ""),
            "to": headers.get("to", ""),
            "subject": headers.get("subject", ""),
            "date": date,
            "text": body.strip(),
            "attachments": atts,
        }

    async def list_new_messages(self, cursor):
        cursor = dict(cursor or {})
        ids: list[str] = []
        if cursor.get("history_id"):
            page = None
            while True:
                params = {"startHistoryId": cursor["history_id"], "historyTypes": "messageAdded", "labelId": "INBOX"}
                if page:
                    params["pageToken"] = page
                h = await self._req("GET", f"{GMAIL}/history", params=params)
                if h is None:  # history expired -> full resync
                    cursor = {}
                    break
                for rec in h.get("history", []):
                    for ma in rec.get("messagesAdded", []):
                        ids.append(ma["message"]["id"])
                page = h.get("nextPageToken")
                if not page:
                    cursor["history_id"] = h.get("historyId", cursor["history_id"])
                    break
        if not cursor.get("history_id"):
            prof = await self._req("GET", f"{GMAIL}/profile")
            lst = await self._req("GET", f"{GMAIL}/messages", params={"q": get_settings().gmail_query, "maxResults": 25})
            ids = [x["id"] for x in (lst or {}).get("messages", [])]
            cursor = {"history_id": (prof or {}).get("historyId")}
        out = []
        for mid in dict.fromkeys(ids):
            msg = await self._get_message(mid)
            if msg:
                out.append(msg)
        return out, cursor

    async def search(self, query, limit=20):
        lst = await self._req("GET", f"{GMAIL}/messages", params={"q": query, "maxResults": limit})
        out = []
        for x in (lst or {}).get("messages", [])[:limit]:
            m = await self._req("GET", f"{GMAIL}/messages/{x['id']}", params={"format": "full"})
            if not m:
                continue
            headers = {h["name"].lower(): h["value"] for h in m.get("payload", {}).get("headers", [])}
            text, html, atts = [], [], []
            _walk_parts(m.get("payload", {}), text, html, atts)
            out.append({"id": m["id"], "subject": headers.get("subject", ""), "from": headers.get("from", ""), "date": headers.get("date"),
                        "text": ("\n".join(text) or m.get("snippet", ""))[:4000], "attachment_names": [a["filename"] for a in atts]})
        return out

    async def send(self, to, subject, body, idempotency_key):
        msg = EmailMessage()
        msg["To"] = to
        msg["Subject"] = subject
        msg["X-RG-Idempotency-Key"] = idempotency_key
        msg.set_content(body)
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        res = await self._req("POST", f"{GMAIL}/messages/send", json={"raw": raw})
        return (res or {}).get("id", "")


def _q(rng: str) -> str:
    """Quote the tab part of an A1 range ('Dispatch Oct'!A1:Z21) so tab names with spaces work."""
    from urllib.parse import quote

    if "!" in rng:
        tab, cells = rng.rsplit("!", 1)
        if not tab.startswith("'"):
            tab = "'" + tab.replace("'", "''") + "'"
        rng = f"{tab}!{cells}"
    return quote(rng, safe="")


class LiveSheets(_GoogleBase, SheetsAdapter):
    KEYMAP = {
        "po": "po_ref", "po_ref": "po_ref", "po no": "po_ref", "po number": "po_ref", "order": "po_ref", "reference": "po_ref",
        "customer": "customer", "item": "item", "product": "item",
        "ordered": "qty_ordered", "qty_ordered": "qty_ordered", "order qty": "qty_ordered",
        "delivered": "qty_delivered", "qty_delivered": "qty_delivered", "delivered qty": "qty_delivered",
        "pending": "qty_pending", "qty_pending": "qty_pending", "balance": "qty_pending",
        "updated_at": "updated_at", "updated": "updated_at", "date": "updated_at", "delivery date": "updated_at",
    }

    async def read_delivery(self, ref=None):
        cfg = self.conn.config or {}
        sid, rng = cfg.get("spreadsheet_id"), cfg.get("range", "Sheet1!A1:H500")
        if not sid:
            raise ConnectorUnavailable("sheets", "spreadsheet not configured (POST /connectors/sheets/config)", retryable=False)
        data = await self._req("GET", f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values/{_q(rng)}")
        values = (data or {}).get("values", [])
        if not values:
            return []
        from ..sheet_mapping import apply_mapping
        from ..validator import refs_match

        # confirmed smart mapping (Setup) first, then the built-in header synonyms
        rows = apply_mapping(values, cfg.get("mapping"), self.KEYMAP)
        return [r for r in rows if ref is None or refs_match(r.get("po_ref"), ref)]

    async def read_raw(self, sheet_id=None, tab=None, limit=21):
        cfg = self.conn.config or {}
        sid = sheet_id or cfg.get("spreadsheet_id")
        if not sid:
            raise ConnectorUnavailable("sheets", "spreadsheet not configured", retryable=False)
        rng = f"{tab}!A1:Z{limit}" if tab else (cfg.get("range") or "Sheet1!A1:H500").split("!")[0] + f"!A1:Z{limit}"
        data = await self._req("GET", f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values/{_q(rng)}")
        return (data or {}).get("values", [])

    async def list_files(self, limit=30):
        """The user's Google Sheets, newest first (Drive read-only scope)."""
        data = await self._req("GET", "https://www.googleapis.com/drive/v3/files", params={
            "q": "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false", "orderBy": "modifiedTime desc",
            "pageSize": limit, "fields": "files(id,name,modifiedTime,owners(displayName))"})
        return [{"id": f["id"], "name": f.get("name") or "(untitled)", "modified_at": f.get("modifiedTime")} for f in (data or {}).get("files", [])]

    async def list_tabs(self, sheet_id):
        """Spreadsheet title + its tabs, each with its header row (so we can tell which tab holds deliveries)."""
        meta = await self._req("GET", f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}",
                               params={"fields": "properties.title,sheets.properties(title,index,gridProperties.rowCount)"})
        if meta is None:
            raise ConnectorError("sheets", "We could not open that sheet. Check the link, and that it belongs to the Google account you connected.", retryable=False)
        tabs = [{"title": t["properties"]["title"], "rows": (t["properties"].get("gridProperties") or {}).get("rowCount")} for t in meta.get("sheets", [])]
        if tabs:
            hdr = await self._req("GET", f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}/values:batchGet",
                                  params=[("ranges", f"'{t['title']}'!A1:Z1") for t in tabs])
            for t, vr in zip(tabs, (hdr or {}).get("valueRanges", [])):
                t["header"] = [str(x) for x in ((vr.get("values") or [[]])[0])]
        return {"title": (meta.get("properties") or {}).get("title"), "tabs": tabs}


class LiveDrive(_GoogleBase, DriveAdapter):
    async def search_docs(self, query, limit=5):
        safe = query.replace("'", " ")
        lst = await self._req("GET", "https://www.googleapis.com/drive/v3/files", params={"q": f"fullText contains '{safe}' and trashed=false", "pageSize": limit, "fields": "files(id,name,mimeType,modifiedTime)"})
        out = []
        for f in (lst or {}).get("files", []):
            text = ""
            if f["mimeType"] == "application/vnd.google-apps.document":
                token = await self._token()
                async with httpx.AsyncClient(timeout=20) as c:
                    r = await c.get(f"https://www.googleapis.com/drive/v3/files/{f['id']}/export", params={"mimeType": "text/plain"}, headers={"Authorization": f"Bearer {token}"})
                    if r.status_code == 200:
                        text = r.text[:20000]
            out.append({"id": f["id"], "name": f["name"], "mime": f["mimeType"], "modified": f.get("modifiedTime"), "text": text})
        return out
