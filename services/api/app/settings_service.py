"""Tenant business settings, notification preferences, approver phones and learned aliases."""
from __future__ import annotations

import copy
import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .models import Alias, NotificationPref, Tenant, TenantSetting, UserPhone
from .validator import normalize_ref

DEMO_COMPANY = {"name": "Demo Manufacturing Pvt Ltd", "gstin": "36AAACD1234A1Z9", "state_code": "36", "upi_vpa": "demomfg@okhdfcbank"}


def defaults(tenant_name: str = "") -> dict[str, Any]:
    demo = get_settings().demo_mode
    company = dict(DEMO_COMPANY) if demo else {"name": tenant_name, "gstin": "", "state_code": "", "upi_vpa": ""}
    if tenant_name:
        company["name"] = tenant_name
    return {
        "company": company,
        "digest": {"enabled": True, "time": "09:00", "channels": ["whatsapp"]},
        "receipts_enabled": True,
        "reminder_ladder": [7, 15, 30],
        "gst_default_rate": 18,
        "einvoice_turnover_threshold": 50_000_000,  # Rs 5 crore (configurable)
        "annual_turnover": 60_000_000 if demo else None,
        "language": "en",
        "timezone": "Asia/Kolkata",
        "default_terms_days": 30,
        "items": {"Model X": {"hsn": "8504", "rate": 18}, "Model Y": {"hsn": "8504", "rate": 18}} if demo else {},
    }


NOTIF_DEFAULTS = {"approvals": True, "digest": False, "receipts": True, "problems": True,
                  "channels": ["whatsapp"], "quiet_hours": {"from": "22:00", "to": "07:00"}}


def deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in (patch or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict) and k != "items":
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


async def get_tenant_settings(s: AsyncSession, tenant_id: str) -> dict[str, Any]:
    row = await s.get(TenantSetting, tenant_id)
    t = await s.get(Tenant, tenant_id)
    return deep_merge(defaults(t.name if t else ""), row.data if row else {})


async def put_tenant_settings(s: AsyncSession, tenant_id: str, patch: dict[str, Any], by: str) -> dict[str, Any]:
    row = await s.get(TenantSetting, tenant_id)
    if row is None:
        row = TenantSetting(tenant_id=tenant_id, data={})
        s.add(row)
    row.data = deep_merge(row.data or {}, patch)
    row.updated_by = by
    await s.flush()
    return await get_tenant_settings(s, tenant_id)


async def get_prefs(s: AsyncSession, user_id: str) -> dict[str, Any]:
    row = await s.get(NotificationPref, user_id)
    return deep_merge(NOTIF_DEFAULTS, row.data if row else {})


async def put_prefs(s: AsyncSession, user_id: str, tenant_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    row = await s.get(NotificationPref, user_id)
    if row is None:
        row = NotificationPref(user_id=user_id, tenant_id=tenant_id, data={})
        s.add(row)
    row.data = deep_merge(row.data or {}, patch)
    await s.flush()
    return await get_prefs(s, user_id)


# ------------------------------------------------------------------ phones
def normalize_phone(phone: str | None) -> str | None:
    """'+91 98480 12345' / '098480 12345' / '9848012345' -> '919848012345'. None when not a plausible number."""
    if not phone:
        return None
    digits = re.sub(r"\D", "", phone.split("@")[0])
    if digits.startswith("00"):
        digits = digits[2:]
    if len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) == 10:
        digits = "91" + digits
    return digits if 11 <= len(digits) <= 15 else None


def mask_phone(phone: str | None) -> str | None:
    if not phone:
        return None
    p = normalize_phone(phone) or re.sub(r"\D", "", phone)
    if len(p) < 6:
        return "•••"
    cc = p[:-10] if len(p) > 10 else ""
    local = p[-10:]
    return (f"+{cc} " if cc else "") + f"{local[:2]}••••••{local[-2:]}"


async def user_phone(s: AsyncSession, user_id: str) -> str | None:
    row = await s.get(UserPhone, user_id)
    return row.phone if row else None


async def set_user_phone(s: AsyncSession, user_id: str, tenant_id: str, phone: str | None) -> str | None:
    row = await s.get(UserPhone, user_id)
    if phone is None:
        if row:
            await s.delete(row)
        return None
    if row is None:
        row = UserPhone(user_id=user_id, tenant_id=tenant_id, phone=phone)
        s.add(row)
    row.phone = phone
    await s.flush()
    return phone


# ------------------------------------------------------------------ aliases
def alias_norm(kind: str, alias: str) -> str:
    if kind == "po":
        return normalize_ref(alias) or alias.strip().upper()
    return re.sub(r"[^a-z0-9]", "", alias.lower())


async def save_alias(s: AsyncSession, tenant_id: str, kind: str, alias: str, canonical: str, by: str) -> Alias | None:
    alias, canonical = (alias or "").strip(), (canonical or "").strip()
    if not alias or not canonical:
        return None
    n = alias_norm(kind, alias)
    if n == alias_norm(kind, canonical):
        return None
    row = (await s.execute(select(Alias).where(Alias.tenant_id == tenant_id, Alias.kind == kind, Alias.alias_norm == n))).scalar_one_or_none()
    if row is None:
        row = Alias(tenant_id=tenant_id, kind=kind, alias=alias, alias_norm=n, canonical=canonical, created_by=by)
        s.add(row)
    else:
        row.canonical, row.created_by = canonical, by
    await s.flush()
    return row


async def list_aliases(s: AsyncSession, tenant_id: str) -> list[Alias]:
    return list((await s.execute(select(Alias).where(Alias.tenant_id == tenant_id).order_by(Alias.kind, Alias.alias))).scalars().all())


async def resolve_aliases(s: AsyncSession, tenant_id: str, fields: dict[str, Any], text: str) -> dict[str, Any]:
    """Apply learned aliases to extracted fields. Returns {po_ref?, customer?, via:[...]} of what changed."""
    rows = await list_aliases(s, tenant_id)
    out: dict[str, Any] = {"via": []}
    po = fields.get("po_ref")
    po_rows = [r for r in rows if r.kind == "po"]
    if po:
        n = alias_norm("po", str(po))
        hit = next((r for r in po_rows if r.alias_norm == n), None)
        if hit:
            out["po_ref"] = hit.canonical
            out["via"].append(f"po alias {hit.alias} = {hit.canonical}")
    elif text:
        for r in po_rows:
            # a learned bare/variant reference typed in a message, e.g. "184"
            if re.search(rf"(?<![\w-]){re.escape(r.alias)}(?![\w-])", text, flags=re.I):
                out["po_ref"] = r.canonical
                out["via"].append(f"po alias {r.alias} = {r.canonical}")
                break
    cust = fields.get("customer")
    cust_rows = [r for r in rows if r.kind == "customer"]
    if cust:
        n = alias_norm("customer", str(cust))
        hit = next((r for r in cust_rows if r.alias_norm == n), None)
        if hit:
            out["customer"] = hit.canonical
            out["via"].append(f"customer alias {hit.alias} = {hit.canonical}")
    elif text:
        low = re.sub(r"[^a-z0-9 ]", " ", text.lower())
        for r in cust_rows:
            if r.alias.lower() in low or (len(r.alias_norm) >= 5 and r.alias_norm in re.sub(r"[^a-z0-9]", "", low)):
                out["customer"] = r.canonical
                out["via"].append(f"customer alias {r.alias} = {r.canonical}")
                break
    return out
