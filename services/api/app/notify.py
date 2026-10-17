"""Team-only WhatsApp messages via wa-bridge POST /send-internal (approval prompts, "Done" receipts, digest),
signed approval-reply tokens, and the daily digest.

Customer messages NEVER go through here: they only go out through approval + Action Gateway (gateway.py).
Everything here is best-effort and never blocks or fails the case flow.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import select

from . import plain_language as pl
from .audit import append_audit
from .config import get_settings
from .connectors.registry import get_connector
from .db import session_scope, utcnow
from .flags import get_flag, now as vnow, set_flag
from .gst import inr
from .models import Action, Approval, Case, Reminder, Tenant, User, UserPhone
from .observability import get_logger
from .security import APPROVER_ROLES, hmac_hex, sign_headers
from .settings_service import get_prefs, get_tenant_settings, normalize_phone

log = get_logger("notify")
TOKEN_TTL_SECONDS = 6 * 3600
_bg: set[asyncio.Task] = set()


# ------------------------------------------------------------------ tokens
def approval_token(approval_id: str, payload_hash: str, phone: str, ttl: int = TOKEN_TTL_SECONDS, now: float | None = None) -> tuple[str, int]:
    exp = int((now or time.time()) + ttl)
    sig = hmac_hex(f"wa-approval:{approval_id}:{payload_hash}:{normalize_phone(phone)}:{exp}".encode())
    return f"{exp}.{sig}", exp


def verify_approval_token(token: str, approval_id: str, payload_hash: str, phone: str, now: float | None = None) -> str | None:
    """None when valid, else a reason."""
    try:
        exp_s, sig = (token or "").split(".", 1)
        exp = int(exp_s)
    except ValueError:
        return "malformed token"
    if exp < (now or time.time()):
        return "token expired"
    expected = hmac_hex(f"wa-approval:{approval_id}:{payload_hash}:{normalize_phone(phone)}:{exp}".encode())
    if not hmac.compare_digest(expected, sig):
        return "token does not match this approval, payload or phone"
    return None


# ------------------------------------------------------------------ transport
async def send_internal(tenant_id: str, to: str, text: str, approval: dict[str, Any] | None = None, kind: str = "internal") -> dict[str, Any]:
    """Team message. Mock WhatsApp connector: recorded in connector config (mock.internal_sent). Live: wa-bridge /send-internal."""
    async with session_scope() as s:
        conn = await get_connector(s, tenant_id, "whatsapp")
        mode = conn.mode
        if mode == "mock":
            cfg = dict(conn.config or {})
            m = dict(cfg.get("mock") or {})
            sent = list(m.get("internal_sent") or [])[-199:]
            sent.append({"to": to, "text": text, "kind": kind, "approval_id": (approval or {}).get("id"), "at": utcnow().isoformat()})
            m["internal_sent"] = sent
            cfg["mock"] = m
            conn.config = cfg
        await append_audit(s, tenant_id, "notify.internal", "notify", {"kind": kind, "to_redacted": True, "approval_id": (approval or {}).get("id"), "mode": mode})
    if mode == "mock":
        return {"ok": True, "mode": "mock"}
    body = {"to": to, "text": text}
    if approval:
        body["approval"] = approval
    raw = json.dumps(body).encode()
    try:
        async with httpx.AsyncClient(timeout=5, trust_env=False) as c:
            r = await c.post(f"{get_settings().wa_bridge_url}/send-internal", content=raw, headers=sign_headers(raw))
        return {"ok": r.status_code < 400, "status": r.status_code}
    except httpx.HTTPError as e:
        log.warning("notify.send_internal_failed", error=str(e)[:200], kind=kind)
        return {"ok": False, "error": str(e)[:200]}


def _background(coro) -> None:
    t = asyncio.create_task(coro)
    _bg.add(t)
    t.add_done_callback(_bg.discard)


async def wait_background(timeout: float = 5) -> None:
    if _bg:
        await asyncio.wait(list(_bg), timeout=timeout)


# ------------------------------------------------------------------ approval prompts
async def _approver_phones(s, tenant_id: str, exclude_user_ids: set[str] = frozenset(), pref: str = "approvals") -> list[tuple[User, str]]:
    rows = (await s.execute(select(User, UserPhone).join(UserPhone, UserPhone.user_id == User.id).where(User.tenant_id == tenant_id, User.active.is_(True)))).all()
    out = []
    for u, p in rows:
        if u.role not in APPROVER_ROLES or u.id in exclude_user_ids:
            continue
        prefs = await get_prefs(s, u.id)
        if not prefs.get(pref, True) or "whatsapp" not in (prefs.get("channels") or ["whatsapp"]):
            continue
        out.append((u, p.phone))
    return out


async def prompt_text(s, ap: Approval, lang: str) -> str:
    from .business import approval_card

    card = await approval_card(s, ap)
    proofs = ", ".join(p["label"] for p in card["proofs"]) or "-"
    return pl.text(pl.APPROVAL_PROMPT, lang, what=card["what"], customer=card["customer"] or "-", po=card["po_ref"] or "-",
                   amount=inr(card["amount"]), gst=inr(card["gst"]), total=inr(card["total"]), proofs=proofs)


async def prompt_approvers(approval_id: str) -> int:
    """Send the numbered WhatsApp prompt to every linked approver phone. Returns how many were sent."""
    jobs: list[tuple[str, str, str, dict[str, Any]]] = []
    async with session_scope() as s:
        ap = await s.get(Approval, approval_id)
        if ap is None or ap.status not in ("pending", "partially_approved"):
            return 0
        done = {a["user_id"] for a in ap.approvers or []}
        phones = await _approver_phones(s, ap.tenant_id, done)
        if not phones:
            return 0
        lang = (await get_tenant_settings(s, ap.tenant_id)).get("language", "en")
        txt = await prompt_text(s, ap, lang)
        for _u, phone in phones:
            token, exp = approval_token(ap.id, ap.payload_hash, phone)
            jobs.append((ap.tenant_id, phone, txt, {"id": ap.id, "token": token, "expires_at": exp}))
    for tid, phone, txt, appr in jobs:
        await send_internal(tid, phone, txt, appr, kind="approval_prompt")
    return len(jobs)


async def approval_created(case_id: str) -> None:
    try:
        async with session_scope() as s:
            ap = (await s.execute(select(Approval).where(Approval.case_id == case_id, Approval.status.in_(("pending", "partially_approved"))).order_by(Approval.created_at.desc()).limit(1))).scalar_one_or_none()
            if ap is None:
                return
            any_phone = (await s.execute(select(UserPhone.user_id).where(UserPhone.tenant_id == ap.tenant_id).limit(1))).first()
            conn = await get_connector(s, ap.tenant_id, "whatsapp")
            live = conn.mode != "mock"
            ap_id = ap.id
        if not any_phone:
            return
        if live:
            _background(_safe(prompt_approvers(ap_id)))  # HTTP to the bridge never blocks the case flow
        else:
            await prompt_approvers(ap_id)
    except Exception:  # noqa: BLE001
        log.exception("notify.approval_created_failed", case_id=case_id)


async def _safe(coro):
    try:
        return await coro
    except Exception:  # noqa: BLE001
        log.exception("notify.background_failed")


async def action_verified(case_id: str, action_id: str) -> None:
    """After the verifier passes: mark reminders sent, tell the approvers 'Done. Invoice ... checked'."""
    try:
        jobs = []
        async with session_scope() as s:
            act = await s.get(Action, action_id)
            if act is None:
                return
            for r in (await s.execute(select(Reminder).where(Reminder.approval_id == act.approval_id))).scalars().all():
                r.status = "sent"
            if act.type != "create_invoice":
                return
            ap = await s.get(Approval, act.approval_id)
            approver_ids = {a["user_id"] for a in (ap.approvers or [])} if ap else set()
            lang = (await get_tenant_settings(s, act.tenant_id)).get("language", "en")
            total = (act.response or {}).get("total") or (act.request.get("gst") or {}).get("total") or act.request.get("amount")
            txt = pl.text(pl.APPROVAL_DONE, lang, invoice=(act.response or {}).get("invoice_number") or act.target_id, total=inr(total or 0))
            rows = (await s.execute(select(UserPhone).where(UserPhone.user_id.in_(approver_ids or {"-"})))).scalars().all()
            jobs = [(act.tenant_id, r.phone, txt) for r in rows]
        for tid, phone, txt in jobs:
            await send_internal(tid, phone, txt, kind="approval_done")
    except Exception:  # noqa: BLE001
        log.exception("notify.action_verified_failed", case_id=case_id)


async def handle_approval_reply(phone: str, approval_id: str, choice: str, token: str) -> tuple[int, dict[str, Any]]:
    """WhatsApp '1' / '2' / '3' from a linked approver phone -> the SAME approve/reject used by the web."""
    from .approvals import ApprovalError, approve, reject
    from .business import approval_card

    ph = normalize_phone(phone)
    choice = {"1": "approve", "2": "reject", "3": "proof"}.get(str(choice).strip(), str(choice).strip().lower())
    if choice not in ("approve", "reject", "proof") or not ph:
        return 422, {"ok": False, "detail": "choice must be 1/2/3 (approve/reject/proof) and phone must be valid"}
    async with session_scope() as s:
        ap = await s.get(Approval, approval_id)
        if ap is None:
            return 404, {"ok": False, "detail": "approval not found"}
        tenant_id = ap.tenant_id
        bad = verify_approval_token(token, ap.id, ap.payload_hash, ph)
        if bad:
            await append_audit(s, tenant_id, "wa_approval.rejected_token", "wa-bridge", {"approval_id": ap.id, "reason": bad}, ap.case_id)
            return 401, {"ok": False, "detail": f"invalid approval token: {bad}"}
        row = (await s.execute(select(UserPhone, User).join(User, User.id == UserPhone.user_id).where(UserPhone.tenant_id == tenant_id, UserPhone.phone == ph))).first()
        if row is None or row[1].role not in APPROVER_ROLES or not row[1].active:
            await append_audit(s, tenant_id, "wa_approval.phone_not_approver", "wa-bridge", {"approval_id": ap.id}, ap.case_id)
            return 403, {"ok": False, "detail": "this phone is not linked to a finance approver"}
        user = row[1]
        lang = (await get_tenant_settings(s, tenant_id)).get("language", "en")
        status = ap.status
        case_id = ap.case_id
        if choice == "proof":
            card = await approval_card(s, ap)
            lines = [f"- {p['label']}" for p in card["proofs"]]
            return 200, {"ok": True, "reply": "\n".join([card["what"]] + lines) or "-"}
    if status == "expired":
        reply = pl.text(pl.APPROVAL_EXPIRED, lang)
        async with session_scope() as s:
            new = (await s.execute(select(Approval).where(Approval.case_id == case_id, Approval.status.in_(("pending", "partially_approved"))).order_by(Approval.created_at.desc()).limit(1))).scalar_one_or_none()
            new_id = new.id if new else None
        if new_id:
            await prompt_approvers(new_id)
        return 409, {"ok": False, "reply": reply, "new_approval_id": new_id}
    try:
        out = await approve(approval_id, user, "via WhatsApp") if choice == "approve" else await reject(approval_id, user, "rejected via WhatsApp")
    except ApprovalError as e:
        return e.status, {"ok": False, "detail": e.message, "reply": e.message}
    async with session_scope() as s:
        await append_audit(s, tenant_id, "wa_approval.decided", user.email, {"approval_id": approval_id, "choice": choice, "status": out["status"]}, case_id)
    return 200, {"ok": True, "status": out["status"], "reply": pl.APPROVAL_ACK[lang if lang in pl.LANGS else "en"][out["status"] if out["status"] in ("approved", "partially_approved", "rejected") else "approved"]}


# ------------------------------------------------------------------ daily digest
DIGEST_FLAG = "digest:last_date"


async def run_digest(tenant_id: str, force: bool = False) -> dict[str, Any]:
    """Send the opt-in daily digest at the tenant's time (default 09:00 Asia/Kolkata). Logged in audit."""
    from .business import dashboard_summary

    async with session_scope() as s:
        st = await get_tenant_settings(s, tenant_id)
        dg = st.get("digest") or {}
        tz = ZoneInfo(st.get("timezone") or "Asia/Kolkata")
        local = (await vnow(s, tenant_id)).astimezone(tz)
        today = local.date().isoformat()
        if not force:
            if not dg.get("enabled", True):
                return {"sent": 0, "skipped": "digest disabled"}
            hh, mm = (dg.get("time") or "09:00").split(":")
            if (local.hour, local.minute) < (int(hh), int(mm)):
                return {"sent": 0, "skipped": "not time yet"}
            if await get_flag(s, tenant_id, DIGEST_FLAG) == today:
                return {"sent": 0, "skipped": "already sent today"}
        if not force:
            await set_flag(s, tenant_id, DIGEST_FLAG, today)  # a manual (forced) send does not use up today's scheduled one
        users = (await s.execute(select(User).where(User.tenant_id == tenant_id, User.active.is_(True)))).scalars().all()
        targets = []
        for u in users:
            prefs = await get_prefs(s, u.id)
            if not prefs.get("digest"):
                continue  # opt-in per user
            phone = (await s.get(UserPhone, u.id))
            targets.append((u, prefs, phone.phone if phone else None))
        lang = st.get("language", "en")
    summary = await dashboard_summary(tenant_id, "month")
    txt = pl.text(pl.DIGEST, lang, bill_n=summary["not_billed"]["count"], bill_amt=inr(summary["not_billed"]["amount"]),
                  chase_n=summary["overdue"]["count"], chase_amt=inr(summary["overdue"]["amount"]), wait_n=summary["waiting"]["count"])
    channels = set(dg.get("channels") or ["whatsapp"])
    sent = []
    for u, prefs, phone in targets:
        uch = set(prefs.get("channels") or ["whatsapp"]) & channels
        if "whatsapp" in uch and phone:
            await send_internal(tenant_id, phone, txt, kind="digest")
            sent.append({"user": u.email, "channel": "whatsapp"})
        if "email" in uch:
            try:
                from .connectors.registry import adapter

                async with session_scope() as s:
                    gm = await adapter(s, tenant_id, "gmail")
                    await gm.send(u.email, "RevenueGuard daily digest", txt, f"digest:{today}:{u.id}")
                sent.append({"user": u.email, "channel": "email"})
            except Exception as e:  # noqa: BLE001
                log.warning("digest.email_failed", error=str(e)[:200])
    async with session_scope() as s:
        await append_audit(s, tenant_id, "digest.sent", "digest", {"date": today, "recipients": len(sent), "channels": sorted({x["channel"] for x in sent}),
                                                                  "to_bill": summary["not_billed"]["count"], "to_chase": summary["overdue"]["count"], "waiting": summary["waiting"]["count"]})
    return {"sent": len(sent), "recipients": sent, "text": txt, "date": today}


async def digest_all(ctx=None) -> int:
    async with session_scope() as s:
        tids = (await s.execute(select(Tenant.id))).scalars().all()
    n = 0
    for t in tids:
        try:
            n += (await run_digest(t)).get("sent", 0)
        except Exception:  # noqa: BLE001
            log.exception("digest.failed", tenant_id=t)
    return n
