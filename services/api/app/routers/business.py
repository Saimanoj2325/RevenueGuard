"""UX v2 business endpoints (docs/CONTRACT_V2.md): dashboard, To bill, To collect, case summary, fact correction,
bulk approve, customers, unlinked inbox, aliases, reminders, reports, settings, team, notifications, phone, setup
backfill and Ask. Roles are enforced here (not only in the UI)."""
from __future__ import annotations

import re
import time
import uuid
from collections import defaultdict, deque
from datetime import date, timedelta
from decimal import InvalidOperation
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import business as biz
from .. import case_service as cs
from ..approvals import ApprovalError, approve
from ..audit import append_audit
from ..db import get_session, session_scope
from ..deps import current_user, require_role
from ..models import Case, NotBillableMark, Snooze, User
from ..security import APPROVER_ROLES
from ..settings_service import (
    get_prefs, get_tenant_settings, list_aliases, mask_phone, normalize_phone, put_prefs, put_tenant_settings, save_alias, set_user_phone, user_phone,
)

router = APIRouter()
Lang = Optional[Literal["en", "hi", "te"]]


async def _case(session: AsyncSession, user: User, ref: str) -> Case:
    c = (await session.execute(select(Case).where(Case.tenant_id == user.tenant_id, or_(Case.id == ref, Case.case_number == ref)))).scalar_one_or_none()
    if c is None:
        raise HTTPException(404, "case not found")
    return c


# ------------------------------------------------------------------ dashboard / lists
@router.get("/dashboard/summary")
async def dashboard(period: Literal["month", "30d", "quarter"] = "month", lang: Lang = "en", user: User = Depends(current_user)):
    return await biz.dashboard_summary(user.tenant_id, period, lang or "en")


@router.get("/bill")
async def bill(status: Optional[str] = None, customer: Optional[str] = None, q: Optional[str] = None, lang: Lang = "en", user: User = Depends(current_user)):
    async with session_scope() as s:
        w = await biz.load_world(s, user.tenant_id)
    rows = biz.bill_rows(w, status, customer, q, lang or "en")
    return {"items": rows, "total_amount": sum(r["amount"] for r in rows)}


@router.get("/collect")
async def collect(bucket: Literal["all", "0-7", "8-30", "31-60", "60+"] = "all", user: User = Depends(current_user)):
    async with session_scope() as s:
        w = await biz.load_world(s, user.tenant_id, with_cases=False)
    rows = biz.chase_rows(w, bucket)
    return {"items": rows, "total_amount": sum(r["amount"] for r in rows)}


class NotBillableBody(BaseModel):
    reason: Literal["sample", "replacement", "returned", "billed_elsewhere", "other"]
    note: str = Field(default="", max_length=1000)


@router.post("/bill/{case_ref}/not-billable")
async def not_billable(case_ref: str, body: NotBillableBody, user: User = Depends(require_role("operator")), session: AsyncSession = Depends(get_session)):
    c = await _case(session, user, case_ref)
    if c.state == "CLOSED":
        raise HTTPException(409, "This case is closed; nothing is waiting to be billed.")
    session.add(NotBillableMark(tenant_id=user.tenant_id, case_id=c.id, reason=body.reason, note=body.note, marked_by=user.email))
    await append_audit(session, user.tenant_id, "bill.not_billable", user.email, {"reason": body.reason, "note": body.note}, c.id, c.correlation_id)
    cs.queue_event(session, user.tenant_id, {"type": "case.updated", "case_id": c.id, "case_number": c.case_number, "state": c.state})
    await session.commit()
    return {"ok": True}


class SnoozeBody(BaseModel):
    days: int = Field(ge=1, le=90)
    reason: str = Field(default="", max_length=500)


@router.post("/collect/{invoice_number}/snooze")
async def snooze(invoice_number: str, body: SnoozeBody, user: User = Depends(require_role("operator"))):
    from ..flags import now as vnow

    async with session_scope() as s:
        w = await biz.load_world(s, user.tenant_id, with_cases=False)
        inv = next((i for i in w.invoices if (i.get("invoice_number") or "").upper() == invoice_number.upper()), None)
        if inv is None:
            raise HTTPException(404, "invoice not found")
        until = (await vnow(s, user.tenant_id)) + timedelta(days=body.days)
        s.add(Snooze(tenant_id=user.tenant_id, invoice_number=inv["invoice_number"], customer_id=inv.get("customer_id"), until=until, reason=body.reason, created_by=user.email))
        await append_audit(s, user.tenant_id, "collect.snoozed", user.email, {"invoice": inv["invoice_number"], "days": body.days, "reason": body.reason})
    return {"ok": True, "snoozed_until": until.isoformat()}


class DraftReminderBody(BaseModel):
    stage: Optional[int] = Field(default=None, ge=1, le=365)
    lang: Lang = None


@router.post("/collect/{invoice_number}/draft-reminder")
async def draft_reminder(invoice_number: str, body: DraftReminderBody = DraftReminderBody(), user: User = Depends(require_role("operator"))):
    from ..reminders import ReminderError, draft_reminder as _draft

    try:
        return await _draft(user.tenant_id, invoice_number, body.stage, user.email, body.lang)
    except ReminderError as e:
        raise HTTPException(e.status, e.message) from e


# ------------------------------------------------------------------ case business view
@router.get("/cases/{case_ref}/summary")
async def case_summary(case_ref: str, lang: Lang = "en", user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    c = await _case(session, user, case_ref)
    return await biz.case_summary(session, c, lang or "en")


class CorrectBody(BaseModel):
    value: str = Field(min_length=1, max_length=200)
    note: str = Field(default="", max_length=1000)


CORRECTABLE = {"delivered_qty": ("qty_delivered", "Delivered"), "order_qty": ("qty_ordered", "Ordered"), "rate": ("rate", "Rate"), "customer": ("customer", "Customer"), "po_ref": ("po_ref", "PO number")}


@router.post("/cases/{case_ref}/facts/{fact_id}/correct")
async def correct_fact(case_ref: str, fact_id: str, body: CorrectBody, user: User = Depends(require_role("operator"))):
    from ..validator import D, normalize_ref

    if fact_id not in CORRECTABLE:
        raise HTTPException(422, f"this fact cannot be corrected here; correctable: {', '.join(CORRECTABLE)}")
    key, label = CORRECTABLE[fact_id]
    async with session_scope() as s:
        c = (await s.execute(select(Case).where(Case.tenant_id == user.tenant_id, or_(Case.id == case_ref, Case.case_number == case_ref)))).scalar_one_or_none()
        if c is None:
            raise HTTPException(404, "case not found")
        if c.state == "CLOSED":
            raise HTTPException(409, "This case is closed; the invoice already went out. Raise a credit note in Zoho instead.")
        before = await cs.compute_facts(s, c)
        old = {"qty_delivered": before.delivered_qty, "qty_ordered": before.order_qty, "rate": before.rate, "customer": before.customer_name or c.customer,
               "po_ref": c.po_ref}[key]
        fields: dict[str, Any] = {"po_ref": c.po_ref, "is_correction": True, "corrected_by": user.email, "note": body.note, "doc_type": "correction"}
        if key == "po_ref":
            # The case was opened under the wrong PO (e.g. the challan photo was misread as PO-148). Move the case to the
            # right PO; evidence filed under the old number stays part of the case (validator reads po_ref_from).
            value = body.value.strip().upper()
            norm = normalize_ref(value)
            if not norm or not re.search(r"\d", norm):
                raise HTTPException(422, "enter a PO number, e.g. PO-184")
            if norm == c.po_ref_norm:
                raise HTTPException(422, "that is already this case's PO")
            other = (await s.execute(select(Case).where(Case.tenant_id == user.tenant_id, Case.po_ref_norm == norm, Case.id != c.id, Case.state != "CLOSED"))).scalars().first()
            if other is not None:
                raise HTTPException(409, f"{value} already has open case {other.case_number}. Open that case, or link this item from Unlinked.")
            fields.update({"po_ref": value, "po_ref_from": c.po_ref})
            # no alias learned on purpose: PO-148 may be a real, different PO next time
            from .. import chat_memory

            await chat_memory.rename_po(s, user.tenant_id, c, c.po_ref, value)
            if c.title and c.po_ref and c.po_ref in c.title:
                c.title = c.title.replace(c.po_ref, value)
            c.po_ref, c.po_ref_norm = value, norm
        elif key == "customer":
            value: Any = body.value.strip()
            fields["customer"] = value
            from ..invoicing import contact_for  # noqa: F401
            from ..connectors.registry import adapter

            try:
                contacts = await (await adapter(s, user.tenant_id, "zoho")).list_contacts()
                ct = next((x for x in contacts if (x.get("contact_name") or "").lower() == value.lower()), None)
                if ct:
                    fields["customer_id"] = ct["contact_id"]
            except Exception:  # noqa: BLE001
                pass
            if old and str(old).strip().lower() != value.lower():
                await save_alias(s, user.tenant_id, "customer", str(old), value, user.email)
            c.customer = value
        else:
            try:
                v = D(body.value)
            except (InvalidOperation, ValueError) as e:
                raise HTTPException(422, "value must be a number") from e
            if v < 0:
                raise HTTPException(422, "value must not be negative")
            value = float(v)
            fields[key] = value
        node, _ = await cs.add_evidence(s, c, user.tenant_id, kind="correction_manual", source="manual", source_id=f"manual:{fact_id}:{uuid.uuid4().hex[:12]}",
                                        title=f"Correction by {user.email}: {label} {old if old is not None else '?'} -> {value}", excerpt=body.note or f"{label} corrected to {value}",
                                        fields=fields, actor=user.email, material=True)
        node.untrusted_flag = False
        after = await cs.compute_facts(s, c)
        c.facts = {**(c.facts or {}), **after.to_json()}
        await append_audit(s, user.tenant_id, "fact.corrected", user.email, {"fact": fact_id, "old": str(old) if old is not None else None, "new": str(value), "note": body.note,
                                                                           "node_id": node.id, "evidence_version": c.evidence_version,
                                                                           "billable": after.to_json().get("billable")}, c.id, c.correlation_id)
        cs.queue_event(s, user.tenant_id, {"type": "case.updated", "case_id": c.id, "case_number": c.case_number, "state": c.state})
        ev, cid, state = c.evidence_version, c.id, c.state
    from ..jobs import enqueue_advance

    if state in ("WATCHING", "INVESTIGATING", "PAUSED", "VALIDATED", "EVIDENCE_READY", "PROPOSED", "ESCALATED"):
        if state == "ESCALATED":
            async with session_scope() as s:
                c = await s.get(Case, cid)
                f = await cs.compute_facts(s, c)
                if not f.conflicts:
                    await cs.transition(s, c, "INVESTIGATING", f"fact corrected by {user.email}; conflict resolved", actor=user.email)
        await enqueue_advance(cid)
    return {"ok": True, "evidence_version": ev}


# ------------------------------------------------------------------ approvals
class BulkBody(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=50)


@router.post("/approvals/bulk-approve")
async def bulk_approve(body: BulkBody, user: User = Depends(current_user)):
    if user.role not in APPROVER_ROLES:
        async with session_scope() as s:
            await append_audit(s, user.tenant_id, "approval.role_blocked", user.email, {"bulk": True, "ids": body.ids, "role": user.role})
        raise HTTPException(403, f"role '{user.role}' cannot approve financial actions")
    results = []
    for aid in dict.fromkeys(body.ids):
        try:
            out = await approve(aid, user, "bulk approve")  # the SAME single-approve logic per id
            results.append({"id": aid, "ok": True, "detail": out["status"]})
        except ApprovalError as e:
            results.append({"id": aid, "ok": False, "detail": e.message})
    return {"results": results}


# ------------------------------------------------------------------ customers
@router.get("/customers")
async def customers(user: User = Depends(current_user)):
    async with session_scope() as s:
        w = await biz.load_world(s, user.tenant_id)
    return {"items": biz.customers_list(w)}


@router.get("/customers/{cid}")
async def customer(cid: str, user: User = Depends(current_user)):
    async with session_scope() as s:
        w = await biz.load_world(s, user.tenant_id)
        extra = []
        for cv in w.cases:
            if cv.customer_id == cid and cv.not_billable:
                extra.append({"at": cv.not_billable.created_at.isoformat(), "kind": "note", "text": f"{cv.case.po_ref} marked not billable ({cv.not_billable.reason}) by {cv.not_billable.marked_by}",
                              "status": "done"})
        for sn in w.snoozes:
            if sn.customer_id == cid:
                extra.append({"at": sn.created_at.isoformat(), "kind": "snooze", "text": f"{sn.invoice_number} snoozed until {sn.until.date().isoformat()}: {sn.reason}", "status": "active" if sn.until > w.now else "ended"})
    out = biz.customer_detail(w, cid, extra)
    if out is None:
        raise HTTPException(404, "customer not found")
    return out


# ------------------------------------------------------------------ unlinked / aliases
class LinkBody(BaseModel):
    case_ref: str


@router.get("/unlinked")
async def unlinked(user: User = Depends(current_user)):
    from ..unlinked import list_unlinked

    return {"items": await list_unlinked(user.tenant_id)}


@router.post("/unlinked/{item_id}/link")
async def unlinked_link(item_id: str, body: LinkBody, user: User = Depends(require_role("operator"))):
    from ..unlinked import UnlinkedError, link_item

    try:
        return await link_item(user.tenant_id, item_id, body.case_ref, user.email)
    except UnlinkedError as e:
        raise HTTPException(e.status, e.message) from e


@router.post("/unlinked/{item_id}/ignore")
async def unlinked_ignore(item_id: str, user: User = Depends(require_role("operator"))):
    from ..unlinked import UnlinkedError, ignore_item

    try:
        return await ignore_item(user.tenant_id, item_id, user.email)
    except UnlinkedError as e:
        raise HTTPException(e.status, e.message) from e


@router.get("/aliases")
async def aliases(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return {"items": [{"kind": a.kind, "alias": a.alias, "canonical": a.canonical} for a in await list_aliases(session, user.tenant_id)]}


# ------------------------------------------------------------------ reports
def _range(frm: Optional[str], to: Optional[str], today: date) -> tuple[date, date]:
    try:
        b = date.fromisoformat(to) if to else today
        a = date.fromisoformat(frm) if frm else date(b.year - (1 if b.month <= 5 else 0), (b.month - 6) % 12 + 1, 1)
    except ValueError as e:
        raise HTTPException(422, "from/to must be YYYY-MM-DD") from e
    if a > b:
        raise HTTPException(422, "from must be before to")
    return a, b


@router.get("/reports/summary")
async def reports_summary(frm: Optional[str] = Query(default=None, alias="from"), to: Optional[str] = None, user: User = Depends(current_user)):
    async with session_scope() as s:
        w = await biz.load_world(s, user.tenant_id)
    a, b = _range(frm, to, w.today)
    return {**biz.reports_summary(w, a, b), "from": a.isoformat(), "to": b.isoformat()}


@router.get("/reports/export")
async def reports_export(frm: Optional[str] = Query(default=None, alias="from"), to: Optional[str] = None, format: Literal["csv"] = "csv",
                         user: User = Depends(current_user)):
    async with session_scope() as s:
        w = await biz.load_world(s, user.tenant_id, with_cases=False)
        a, b = _range(frm, to, w.today)
        await append_audit(s, user.tenant_id, "reports.exported", user.email, {"from": a.isoformat(), "to": b.isoformat(), "format": format})
    return Response(biz.export_csv(w, a, b), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="revenueguard-{a.isoformat()}-to-{b.isoformat()}.csv"'})


# ------------------------------------------------------------------ settings / team / notifications / phone
class CompanyIn(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    gstin: Optional[str] = None
    state_code: Optional[str] = None
    upi_vpa: Optional[str] = None

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v):
        if v and not re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]", v.strip().upper()):
            raise ValueError("GSTIN must be 15 characters like 36AAACD1234A1Z9")
        return v.strip().upper() if v else v

    @field_validator("upi_vpa")
    @classmethod
    def _vpa(cls, v):
        if v and not re.fullmatch(r"[A-Za-z0-9.\-_]{2,256}@[A-Za-z]{2,64}", v.strip()):
            raise ValueError("UPI ID must look like name@bank")
        return v.strip() if v else v


class DigestIn(BaseModel):
    enabled: Optional[bool] = None
    time: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    channels: Optional[list[Literal["whatsapp", "email"]]] = None


class SettingsIn(BaseModel):
    company: Optional[CompanyIn] = None
    digest: Optional[DigestIn] = None
    receipts_enabled: Optional[bool] = None
    reminder_ladder: Optional[list[int]] = Field(default=None, min_length=1, max_length=6)
    gst_default_rate: Optional[float] = Field(default=None, ge=0, le=28)
    einvoice_turnover_threshold: Optional[int] = Field(default=None, ge=0)
    annual_turnover: Optional[int] = Field(default=None, ge=0)
    language: Lang = None
    timezone: Optional[str] = None
    default_terms_days: Optional[int] = Field(default=None, ge=0, le=365)
    items: Optional[dict[str, dict[str, Any]]] = None


@router.get("/settings")
async def get_settings_ep(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await get_tenant_settings(session, user.tenant_id)


@router.put("/settings")
async def put_settings_ep(body: SettingsIn, user: User = Depends(require_role("admin")), session: AsyncSession = Depends(get_session)):
    patch = body.model_dump(exclude_none=True)
    if "company" in patch and patch["company"].get("gstin") and not patch["company"].get("state_code"):
        patch["company"]["state_code"] = patch["company"]["gstin"][:2]
    if "reminder_ladder" in patch:
        patch["reminder_ladder"] = sorted({int(x) for x in patch["reminder_ladder"] if 0 < int(x) <= 365})
    out = await put_tenant_settings(session, user.tenant_id, patch, user.email)
    await append_audit(session, user.tenant_id, "settings.updated", user.email, {"keys": sorted(patch)})
    await session.commit()
    return out


@router.get("/settings/team")
async def team(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    users = (await session.execute(select(User).where(User.tenant_id == user.tenant_id).order_by(User.created_at))).scalars().all()
    return {"items": [{"id": u.id, "name": u.name, "email": u.email, "role": u.role, "phone_masked": mask_phone(await user_phone(session, u.id))} for u in users]}


class QuietHours(BaseModel):
    from_: str = Field(alias="from", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    to: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")


class NotifIn(BaseModel):
    approvals: Optional[bool] = None
    digest: Optional[bool] = None
    receipts: Optional[bool] = None
    problems: Optional[bool] = None
    channels: Optional[list[Literal["whatsapp", "email"]]] = None
    quiet_hours: Optional[QuietHours] = None


@router.get("/settings/notifications")
async def get_notifications(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await get_prefs(session, user.id)


@router.put("/settings/notifications")
async def put_notifications(body: NotifIn, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    patch = body.model_dump(exclude_none=True, by_alias=True)
    out = await put_prefs(session, user.id, user.tenant_id, patch)
    await append_audit(session, user.tenant_id, "settings.notifications", user.email, {"keys": sorted(patch)})
    await session.commit()
    return out


class PhoneIn(BaseModel):
    phone: Optional[str] = None


@router.put("/me/phone")
async def put_phone(body: PhoneIn, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    if body.phone in (None, ""):
        await set_user_phone(session, user.id, user.tenant_id, None)
        await append_audit(session, user.tenant_id, "user.phone_unlinked", user.email, {})
        await session.commit()
        return {"ok": True, "phone_masked": None}
    p = normalize_phone(body.phone)
    if not p:
        raise HTTPException(422, "Enter a valid mobile number, e.g. +91 98480 12345")
    await set_user_phone(session, user.id, user.tenant_id, p)
    await append_audit(session, user.tenant_id, "user.phone_linked", user.email, {"phone_masked": mask_phone(p), "can_approve": user.role in APPROVER_ROLES})
    await session.commit()
    return {"ok": True, "phone_masked": mask_phone(p), "can_approve_on_whatsapp": user.role in APPROVER_ROLES}


# ------------------------------------------------------------------ setup backfill
class BackfillIn(BaseModel):
    days: int = Field(default=90, ge=1, le=365)


@router.post("/setup/backfill")
async def backfill_start(body: BackfillIn = BackfillIn(), user: User = Depends(require_role("admin"))):
    from ..backfill import start_backfill

    return {"job_id": await start_backfill(user.tenant_id, body.days, user.email)}


@router.get("/setup/backfill")
async def backfill_status(user: User = Depends(current_user)):
    from ..backfill import latest

    return await latest(user.tenant_id)


# ------------------------------------------------------------------ ask
class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    lang: Lang = None


_ASK_HITS: dict[str, deque] = defaultdict(deque)
ASK_PER_MINUTE = 30


@router.post("/ask")
async def ask_ep(body: AskIn, user: User = Depends(current_user)):
    from ..ask import ask

    q = _ASK_HITS[user.id]
    now = time.monotonic()
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= ASK_PER_MINUTE:
        raise HTTPException(429, "Too many questions in a minute. Please wait a moment.")
    q.append(now)
    async with session_scope() as s:
        lang = body.lang or (await get_tenant_settings(s, user.tenant_id)).get("language", "en")
    out = await ask(user.tenant_id, body.question, lang)
    async with session_scope() as s:
        await append_audit(s, user.tenant_id, "ask.answered", user.email, {"intent": out.get("intent"), "question": body.question[:200]})
    return out
