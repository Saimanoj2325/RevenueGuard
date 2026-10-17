"""GST lines for invoice proposals (bound into the approval payload hash) and buyer lookups."""
from __future__ import annotations

from typing import Any

from .connectors.base import ConnectorError
from .connectors.registry import adapter
from .gst import gst_for_payload, gst_preview
from .settings_service import get_tenant_settings


async def contact_for(s, tenant_id: str, customer_id: str | None) -> dict[str, Any] | None:
    if not customer_id:
        return None
    try:
        contacts = await (await adapter(s, tenant_id, "zoho")).list_contacts()
    except ConnectorError:
        return None
    return next((c for c in contacts if c.get("contact_id") == customer_id), None)


def contact_gstin(c: dict[str, Any] | None) -> str | None:
    if not c:
        return None
    return c.get("gst_no") or c.get("gstin") or None


async def preview_for_action(s, tenant_id: str, action: dict[str, Any]) -> dict[str, Any]:
    settings = await get_tenant_settings(s, tenant_id)
    c = await contact_for(s, tenant_id, action.get("customer_id"))
    return gst_preview(action.get("line_items") or [], settings, contact_gstin(c), (c or {}).get("place_of_contact"))


async def attach_gst(s, tenant_id: str, action: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of a create_invoice action with its `gst` block (part of the hashed payload)."""
    if action.get("type") != "create_invoice" or not action.get("line_items"):
        return action
    out = dict(action)
    out["gst"] = gst_for_payload(await preview_for_action(s, tenant_id, action))
    return out
