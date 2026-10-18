"""Connector management: OAuth web flows (Google, Zoho India DC), WhatsApp QR, bank CSV, sheets config, revoke."""
from __future__ import annotations

import logging

import jwt
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import append_audit
from ..config import get_settings
from ..connectors.bank import parse_bank_csv
from ..connectors.registry import get_connector, list_connectors
from ..db import get_session, utcnow
from ..deps import current_user, require_role
from ..events import emit
from ..models import User
from ..security import encrypt_json, sign_state, verify_state

_log = logging.getLogger(__name__)
router = APIRouter(prefix="/connectors")


async def _sync_whatsapp_status(session: AsyncSession, tenant_id: str) -> str | None:
    """Ask wa-bridge for its real state and fix the stored status when it drifted (a missed 'connection' event,
    an API restart while paired, or a pairing done before the API was up). Returns the bridge state, or None when
    the bridge is unreachable (stored status is left alone)."""
    c = await get_connector(session, tenant_id, "whatsapp")
    if c.mode == "mock":
        return None
    try:
        from ..connectors.whatsapp import BridgeWhatsApp

        st = (await BridgeWhatsApp(session, c, tenant_id).status()) or {}
    except Exception:  # noqa: BLE001 - bridge down: keep what we have
        return None
    if st.get("error"):
        return None
    state = st.get("state")
    want = "connected" if state == "open" else ("disconnected" if state in ("close", "closed", "disconnected", "logged_out", "qr") else None)
    if want and c.status != want and c.status != "revoked":
        c.status = want
        if want == "connected" and not c.authorized_at:
            c.authorized_at, c.authorized_by = utcnow(), "whatsapp-qr"
        await append_audit(session, tenant_id, "connector.whatsapp", "status-sync", {"state": state})
        await session.flush()
        await emit(tenant_id, "connector.updated", name="whatsapp", status=state)
    return state


@router.get("")
async def connectors(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    from ..business import connector_health

    await _sync_whatsapp_status(session, user.tenant_id)
    out = await list_connectors(session, user.tenant_id)
    health = await connector_health(session, user.tenant_id)
    for c in out:
        c.update(health.get(c["name"], {"health": "down", "last_sync": None, "error_plain": None}))
    await session.commit()
    return {"connectors": out, "items": out, "demo_mode": get_settings().demo_mode}


async def _mock_connect(session, user: User, names: list[str]):
    for n in names:
        c = await get_connector(session, user.tenant_id, n)
        c.status, c.mode, c.authorized_by, c.authorized_at = "connected", "mock", user.email, utcnow()
        await append_audit(session, user.tenant_id, "connector.connected", user.email, {"name": n, "mode": "mock"})
    await session.commit()
    for n in names:
        await emit(user.tenant_id, "connector.updated", name=n, status="connected")


@router.get("/google/start")
async def google_start(user: User = Depends(require_role("admin")), session: AsyncSession = Depends(get_session)):
    s = get_settings()
    if s.demo_mode and not s.google_client_id:
        await _mock_connect(session, user, ["gmail", "sheets", "drive"])
        return RedirectResponse(f"{s.web_url}/connectors?connected=google&mode=mock")
    from ..connectors.google import google_auth_url

    return RedirectResponse(google_auth_url(sign_state({"tid": user.tenant_id, "uid": user.id, "email": user.email, "provider": "google"})))


@router.get("/google/callback")
async def google_callback(
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
):
    """Google sends the browser here after consent. Every failure goes back to the app with a plain reason, never a bare 500."""
    from urllib.parse import quote

    import httpx

    from ..connectors.google import google_exchange_code

    back = f"{get_settings().web_url}/setup/connections"

    def fail(reason: str) -> RedirectResponse:
        return RedirectResponse(f"{back}?google_error={quote(reason)}")

    if error:
        return fail("You cancelled the Google sign-in." if error == "access_denied" else f"Google said: {error}")
    if not code or not state:
        return fail("Google did not send a sign-in code. Start again from Connect Gmail.")
    try:
        st = verify_state(state)
    except jwt.PyJWTError:
        return fail("That sign-in link expired. Start again from Connect Gmail.")
    try:
        tok = await google_exchange_code(code)
    except httpx.HTTPStatusError as e:
        try:
            body = e.response.json()
        except ValueError:
            body = {"error": e.response.text[:200]}
        _log.warning("google token exchange failed: %s %s", e.response.status_code, body)
        err = body.get("error")
        if err == "invalid_grant":
            return fail("This sign-in code was already used or expired (did the page get refreshed?). Start again from Connect Gmail.")
        if err == "redirect_uri_mismatch":
            return fail(f"GOOGLE_REDIRECT_URI ({get_settings().google_redirect_uri}) is not listed in your Google Cloud OAuth client.")
        if err in ("invalid_client", "unauthorized_client"):
            return fail("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are wrong in .env.")
        return fail(f"Google refused the sign-in: {err or e.response.status_code}")
    except httpx.HTTPError as e:
        _log.warning("google token exchange network error: %s", e)
        return fail("Could not reach Google from the server. Check its internet connection and try again.")
    enc = encrypt_json(tok)
    for n in ("gmail", "sheets", "drive"):
        c = await get_connector(session, st["tid"], n)
        c.status, c.mode, c.auth_enc, c.authorized_by, c.authorized_at, c.error = "connected", "live", enc, st["email"], utcnow(), None
        if n == "gmail":
            c.cursor = {}
        await append_audit(session, st["tid"], "connector.connected", st["email"], {"name": n, "mode": "live", "scopes": tok.get("scope")})
    await session.commit()
    for n in ("gmail", "sheets", "drive"):
        await emit(st["tid"], "connector.updated", name=n, status="connected")
    return RedirectResponse(f"{back}?connected=google")


@router.get("/zoho/start")
async def zoho_start(user: User = Depends(require_role("admin")), session: AsyncSession = Depends(get_session)):
    s = get_settings()
    if s.demo_mode and not s.zoho_client_id:
        await _mock_connect(session, user, ["zoho"])
        return RedirectResponse(f"{s.web_url}/connectors?connected=zoho&mode=mock")
    from ..connectors.zoho import zoho_auth_url

    return RedirectResponse(zoho_auth_url(sign_state({"tid": user.tenant_id, "uid": user.id, "email": user.email, "provider": "zoho"})))


@router.get("/zoho/callback")
async def zoho_callback(code: str = Query(...), state: str = Query(...), accounts_server: str | None = Query(default=None, alias="accounts-server"), session: AsyncSession = Depends(get_session)):
    from ..connectors.zoho import zoho_exchange_code, zoho_list_orgs

    try:
        st = verify_state(state)
    except jwt.PyJWTError as e:
        raise HTTPException(400, f"bad state: {e}") from e
    if accounts_server and not accounts_server.startswith("https://accounts.zoho."):
        raise HTTPException(400, "unexpected accounts-server")
    tok = await zoho_exchange_code(code, accounts_server)
    org_id = get_settings().zoho_org_id
    if not org_id:
        orgs = await zoho_list_orgs(tok["access_token"])
        org_id = orgs[0]["organization_id"] if orgs else ""
    c = await get_connector(session, st["tid"], "zoho")
    c.status, c.mode, c.auth_enc, c.authorized_by, c.authorized_at, c.error = "connected", "live", encrypt_json(tok), st["email"], utcnow(), None
    c.config = {**(c.config or {}), "organization_id": org_id}
    await append_audit(session, st["tid"], "connector.connected", st["email"], {"name": "zoho", "mode": "live", "organization_id": org_id})
    await session.commit()
    await emit(st["tid"], "connector.updated", name="zoho", status="connected")
    return RedirectResponse(f"{get_settings().web_url}/connectors?connected=zoho")


@router.get("/whatsapp/qr")
async def whatsapp_qr(user: User = Depends(require_role("admin")), session: AsyncSession = Depends(get_session)):
    c = await get_connector(session, user.tenant_id, "whatsapp")
    if c.mode == "mock":
        await _mock_connect(session, user, ["whatsapp"])
        return {"qr": None, "state": "open", "mode": "mock"}
    from ..connectors.whatsapp import BridgeWhatsApp

    b = BridgeWhatsApp(session, c, user.tenant_id)
    st = await b.status()
    qr = await b.qr() if st.get("state") != "open" else {"qr": None}
    return {**qr, "state": st.get("state"), "me": st.get("me")}


_MOCK_GROUPS = {"google": ["gmail", "sheets", "drive"], "gmail": ["gmail"], "sheets": ["sheets"], "drive": ["drive"],
                "zoho": ["zoho"], "whatsapp": ["whatsapp"], "bank": ["bank"]}


@router.post("/{name}/mock-connect")
async def mock_connect(name: str, user: User = Depends(require_role("admin")), session: AsyncSession = Depends(get_session)):
    """DEMO_MODE only: mark a connector (or the Google trio) connected with the mock adapter, so the web's Connect /
    Simulate-scan buttons work against the real API with zero keys."""
    if not get_settings().demo_mode:
        raise HTTPException(403, "mock-connect is only available with DEMO_MODE=true")
    if name not in _MOCK_GROUPS:
        raise HTTPException(404, f"unknown connector {name}")
    await _mock_connect(session, user, _MOCK_GROUPS[name])
    return {"ok": True, "connected": _MOCK_GROUPS[name], "mode": "mock"}


@router.post("/{name}/revoke")
async def revoke(name: str, user: User = Depends(require_role("admin")), session: AsyncSession = Depends(get_session)):
    c = await get_connector(session, user.tenant_id, name)
    google = name in ("gmail", "sheets", "drive")
    if c.mode == "live" and c.auth_enc and google:
        from ..connectors.google import google_revoke

        try:
            await google_revoke(c)
        except Exception:  # noqa: BLE001
            pass
    targets = ["gmail", "sheets", "drive"] if (google and c.mode == "live") else [name]  # one Google grant covers all three
    for n in targets:
        cc = await get_connector(session, user.tenant_id, n)
        cc.status, cc.auth_enc = "revoked", None
        await append_audit(session, user.tenant_id, "connector.revoked", user.email, {"name": n})
    await session.commit()
    for n in targets:
        await emit(user.tenant_id, "connector.updated", name=n, status="revoked")
    return {"revoked": targets}


@router.post("/bank/upload")
async def bank_upload(file: UploadFile = File(...), user: User = Depends(require_role("operator")), session: AsyncSession = Depends(get_session)):
    raw = await file.read()
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(413, "CSV too large")
    rows = parse_bank_csv(raw)
    c = await get_connector(session, user.tenant_id, "bank")
    c.config = {**(c.config or {}), "rows": rows, "filename": file.filename}
    c.status, c.authorized_by, c.authorized_at, c.last_sync_at = "connected", user.email, utcnow(), utcnow()
    await append_audit(session, user.tenant_id, "connector.bank_upload", user.email, {"rows": len(rows), "filename": file.filename})
    await session.commit()
    await emit(user.tenant_id, "connector.updated", name="bank", status="connected")
    return {"rows": len(rows), "credits": sum(1 for r in rows if r["credit"])}


class SheetsConfig(BaseModel):
    spreadsheet_id: str
    range: str = "Sheet1!A1:H500"
    mapping: dict[str, str] | None = None  # confirmed smart mapping {header: meaning}


@router.post("/sheets/config")
async def sheets_config(body: SheetsConfig, user: User = Depends(require_role("admin")), session: AsyncSession = Depends(get_session)):
    from sqlalchemy import select

    from ..models import SheetMapping
    from ..sheet_mapping import MEANINGS

    c = await get_connector(session, user.tenant_id, "sheets")
    cfg = {**(c.config or {}), "spreadsheet_id": body.spreadsheet_id, "range": body.range}
    if body.mapping is not None:
        bad = {h: m for h, m in body.mapping.items() if m not in MEANINGS}
        if bad:
            raise HTTPException(422, f"unknown column meanings: {bad}; allowed: {', '.join(MEANINGS)}")
        cfg["mapping"] = body.mapping
        tab = body.range.split("!")[0] if "!" in body.range else "Sheet1"
        row = (await session.execute(select(SheetMapping).where(SheetMapping.tenant_id == user.tenant_id, SheetMapping.sheet_id == body.spreadsheet_id, SheetMapping.tab == tab))).scalar_one_or_none()
        if row is None:
            row = SheetMapping(tenant_id=user.tenant_id, sheet_id=body.spreadsheet_id, tab=tab, columns=[])
            session.add(row)
        row.mapping, row.confirmed_by = body.mapping, user.email
    c.config = cfg
    await append_audit(session, user.tenant_id, "connector.sheets_config", user.email, body.model_dump())
    await session.commit()
    return {"ok": True}


class ProposeMappingIn(BaseModel):
    sheet_id: str | None = None
    tab: str | None = None


@router.post("/sheets/propose-mapping")
async def sheets_propose_mapping(body: ProposeMappingIn, user: User = Depends(require_role("admin")), session: AsyncSession = Depends(get_session)):
    """Header synonyms first, then value patterns, LLM only as a last resort. The user confirms via /sheets/config."""
    from sqlalchemy import select

    from ..connectors.base import ConnectorError, NotConnected
    from ..connectors.registry import adapter
    from ..models import SheetMapping
    from ..sheet_mapping import propose

    try:
        a = await adapter(session, user.tenant_id, "sheets")
        values = await a.read_raw(body.sheet_id, body.tab)
    except NotConnected as e:
        raise HTTPException(409, "Connect Google Sheets first.") from e
    except ConnectorError as e:
        raise HTTPException(502, f"Could not read the sheet: {str(e)[:160]}") from e
    if not values:
        raise HTTPException(422, "The sheet looks empty. Put the column names in the first row.")
    cols = await propose(values, session=session, tenant_id=user.tenant_id)
    sid = body.sheet_id or (await get_connector(session, user.tenant_id, "sheets")).config.get("spreadsheet_id") or "default"
    tab = body.tab or "Sheet1"
    row = (await session.execute(select(SheetMapping).where(SheetMapping.tenant_id == user.tenant_id, SheetMapping.sheet_id == sid, SheetMapping.tab == tab))).scalar_one_or_none()
    if row is None:
        row = SheetMapping(tenant_id=user.tenant_id, sheet_id=sid, tab=tab, mapping={})
        session.add(row)
    row.columns = cols
    await append_audit(session, user.tenant_id, "connector.sheets_mapping_proposed", user.email, {"sheet_id": sid, "tab": tab, "columns": [{k: c[k] for k in ("header", "meaning", "confidence")} for c in cols]})
    await session.commit()
    return {"columns": cols}


# ------------------------------------------------------------------ WhatsApp chat picker (allowlist)
DEMO_CHATS = [
    {"jid": "120363000000000001@g.us", "name": "Dispatch & Ops", "is_group": True, "kind": "group", "members": 8, "watched": True},
    {"jid": "919800000001@s.whatsapp.net", "name": "Ravi Kumar (Example Customer)", "is_group": False, "kind": "person", "phone": "919800000001", "watched": True},
    {"jid": "120363000000000002@g.us", "name": "Sales team", "is_group": True, "kind": "group", "members": 5, "watched": True},
    {"jid": "120363000000000004@g.us", "name": "Godown Hyderabad", "is_group": True, "kind": "group", "members": 12, "watched": False},
    {"jid": "919811100003@s.whatsapp.net", "name": "Sri Lakshmi Traders accounts", "is_group": False, "kind": "person", "phone": "919811100003", "watched": False},
    {"jid": "919876543204@s.whatsapp.net", "name": None, "is_group": False, "kind": "person", "phone": "919876543204", "watched": False},
    {"jid": "120363000000000010@g.us", "name": "Hyderabad Traders Association", "is_group": True, "kind": "community", "members": 240, "watched": False},
    {"jid": "120363000000000011@g.us", "name": "Hyderabad Traders Association", "is_group": True, "kind": "announcement", "members": 240,
     "parent": "120363000000000010@g.us", "parent_name": "Hyderabad Traders Association", "watched": False},
    {"jid": "120363000000000012@newsletter", "name": "GST Council Updates", "is_group": False, "kind": "channel", "watched": False},
    {"jid": "120363000000000009@g.us", "name": "Family", "is_group": True, "kind": "group", "members": 9, "watched": False},
]
CHAT_KINDS = {"person", "group", "community", "announcement", "channel", "broadcast"}


def _chat_kind(ch: dict) -> str:
    k = ch.get("kind")
    if k in CHAT_KINDS:
        return k
    jid = str(ch.get("jid") or "")
    if jid.endswith("@newsletter"):
        return "channel"
    if jid.endswith("@broadcast"):
        return "broadcast"
    return "group" if jid.endswith("@g.us") or ch.get("is_group") else "person"


def _phone_digits(ch: dict) -> str | None:
    p = ch.get("phone")
    if not p:
        jid = str(ch.get("jid") or "")
        p = jid.split("@")[0].split(":")[0] if jid.endswith("@s.whatsapp.net") else None
    digits = "".join(c for c in str(p or "") if c.isdigit())
    return digits if 8 <= len(digits) <= 15 else None


def _chat_row(ch: dict, ts, watched: bool) -> dict:
    kind = _chat_kind(ch)
    row = {
        "jid": ch.get("jid"),
        # never fall back to the raw JID: the UI formats the phone number (or says the number is hidden)
        "name": ch.get("name") or None,
        "is_group": kind in ("group", "community", "announcement"),
        "kind": kind,
        "last_message_at": ts,
        "watched": watched,
    }
    if kind == "person":
        row["phone"] = _phone_digits(ch)
        if ch.get("push_name"):
            row["push_name"] = ch["push_name"]
    for k in ("members", "parent", "parent_name"):
        if ch.get(k):
            row[k] = ch[k]
    return row


ALLOWLIST_FLAG = "wa_allowlist"


async def _bridge(method: str, path: str, payload: dict | None = None):
    import json as _json

    import httpx

    from ..security import sign_headers

    raw = _json.dumps(payload).encode() if payload is not None else b""
    async with httpx.AsyncClient(timeout=8, trust_env=False) as cl:
        r = await cl.request(method, f"{get_settings().wa_bridge_url}{path}", content=raw if payload is not None else None, headers=sign_headers(raw))
    if r.status_code >= 400:
        raise HTTPException(502, f"WhatsApp bridge refused the request (HTTP {r.status_code}).")
    return r.json()


@router.get("/whatsapp/chats")
async def whatsapp_chats(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    from datetime import datetime, timedelta, timezone

    import httpx
    from sqlalchemy import func, select

    from ..flags import get_flag
    from ..models import WaMessage

    c = await get_connector(session, user.tenant_id, "whatsapp")
    if c.mode == "mock":
        allow = await get_flag(session, user.tenant_id, ALLOWLIST_FLAG, None)
        last = dict((await session.execute(select(WaMessage.chat_id, func.max(WaMessage.ts)).where(WaMessage.tenant_id == user.tenant_id).group_by(WaMessage.chat_id))).all())
        now = datetime.now(timezone.utc)
        items = []
        for i, ch in enumerate(DEMO_CHATS):
            ts = last.get(ch["jid"]) or (now - timedelta(hours=2 + 7 * i))
            items.append(_chat_row(ch, ts.isoformat(), (ch["jid"] in allow) if allow is not None else ch["watched"]))
        return {"items": items, "mode": "mock"}
    state = await _sync_whatsapp_status(session, user.tenant_id)
    await session.commit()
    if state is not None and state != "open":
        # not paired right now: don't show chats left over from an earlier session as if they were live
        return {"items": [], "mode": "live", "state": state}
    try:
        chats = await _bridge("GET", "/chats?limit=2000")
        allow = (await _bridge("GET", "/allowlist")).get("jids", [])
    except httpx.HTTPError as e:
        raise HTTPException(502, "WhatsApp bridge is not reachable. Check that WhatsApp is paired.") from e
    if isinstance(chats, dict):
        chats = chats.get("chats") or chats.get("items") or []
    items = []
    for ch in chats:
        ts = ch.get("last_message_at")
        if isinstance(ts, (int, float)):
            ts = datetime.fromtimestamp(ts / (1000 if ts > 1e12 else 1), tz=timezone.utc).isoformat()
        if str(ch.get("jid") or "") == "status@broadcast":
            continue
        # a person merged from a phone-number chat and a LID chat is watched if either JID is
        watched = ch.get("jid") in allow or any(a in allow for a in (ch.get("aliases") or []))
        items.append(_chat_row(ch, ts, watched))
    return {"items": items, "mode": "live"}


class WatchedIn(BaseModel):
    watched: list[str]


@router.put("/whatsapp/chats")
async def whatsapp_chats_put(body: WatchedIn, user: User = Depends(require_role("admin")), session: AsyncSession = Depends(get_session)):
    import httpx

    from ..flags import set_flag

    jids = sorted({j.strip() for j in body.watched if j and j.strip()})
    c = await get_connector(session, user.tenant_id, "whatsapp")
    if c.mode != "mock":
        try:
            res = await _bridge("PUT", "/allowlist", {"jids": jids})
            jids = res.get("jids", jids)
        except httpx.HTTPError as e:
            raise HTTPException(502, "WhatsApp bridge is not reachable; the watched chats were not changed.") from e
    await set_flag(session, user.tenant_id, ALLOWLIST_FLAG, jids)
    await append_audit(session, user.tenant_id, "connector.whatsapp_allowlist", user.email, {"watched": len(jids), "mode": c.mode})
    await session.commit()
    return {"ok": True, "watched": jids}


@router.post("/gmail/sync")
async def gmail_sync(user: User = Depends(require_role("operator"))):
    from ..sync import sync_gmail

    return await sync_gmail(user.tenant_id)
