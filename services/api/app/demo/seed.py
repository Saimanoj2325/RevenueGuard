"""Seed tenant, demo users (CONTRACT §Roles) and DEMO_MODE mock connector datasets."""
from __future__ import annotations

from typing import Any

from sqlalchemy import select

from ..config import get_settings
from ..connectors.base import CONNECTOR_NAMES
from ..db import session_scope
from ..flags import set_flag
from ..models import Connector, Tenant, User
from ..security import hash_password

DEMO_USERS = [
    ("admin@demo.in", "Asha Admin", "admin"),
    ("ops@demo.in", "Om Operator", "operator"),
    ("finance@demo.in", "Farah Finance", "finance_approver"),
    ("finance2@demo.in", "Firoz Finance", "finance_approver"),
    ("viewer@demo.in", "Vik Viewer", "viewer"),
]
CUSTOMER_ID = "zc-1001"
OTHER_CUSTOMER_ID = "zc-1002"


def mock_datasets() -> dict[str, Any]:
    return {
        "zoho": {
            "seq": 2300,
            "contacts": [
                {"contact_id": CUSTOMER_ID, "contact_name": "Example Customer Pvt Ltd", "email": "accounts@example-customer.in", "mobile": "919800000001", "gst_no": "36AABCE1234F1Z5"},
                {"contact_id": OTHER_CUSTOMER_ID, "contact_name": "Other Traders LLP", "email": "ap@othertraders.in", "mobile": "919800000002", "gst_no": "29AAGFO5678K1Z2"},
            ],
            "salesorders": [
                {"salesorder_id": "so-184", "salesorder_number": "SO-00184", "reference_number": "PO-184", "customer_id": CUSTOMER_ID, "customer_name": "Example Customer Pvt Ltd",
                 "date": "2026-10-05", "status": "confirmed", "total": 100000, "line_items": [{"name": "Model X", "quantity": 100, "rate": 1000}]},
                {"salesorder_id": "so-170", "salesorder_number": "SO-00170", "reference_number": "PO-170", "customer_id": CUSTOMER_ID, "customer_name": "Example Customer Pvt Ltd",
                 "date": "2026-09-12", "status": "closed", "total": 50000, "line_items": [{"name": "Model X", "quantity": 50, "rate": 1000}]},
                {"salesorder_id": "so-185", "salesorder_number": "SO-00185", "reference_number": "PO-185", "customer_id": OTHER_CUSTOMER_ID, "customer_name": "Other Traders LLP",
                 "date": "2026-10-08", "status": "confirmed", "total": 200000, "line_items": [{"name": "Model Y", "quantity": 250, "rate": 800}]},
            ],
            "invoices": [  # decoy: invoice for a DIFFERENT PO of the same customer
                {"invoice_id": "mock-inv-2201", "invoice_number": "INV-2201", "customer_id": CUSTOMER_ID, "customer_name": "Example Customer Pvt Ltd", "reference_number": "PO-170",
                 "date": "2026-09-20", "status": "paid", "total": 50000, "line_items": [{"name": "Model X", "quantity": 50, "rate": 1000, "item_total": 50000}], "notes": ""},
            ],
            "creditnotes": [  # decoy: credit note for ANOTHER customer
                {"creditnote_id": "cn-12", "creditnote_number": "CN-12", "customer_id": OTHER_CUSTOMER_ID, "customer_name": "Other Traders LLP", "reference_number": "PO-151", "total": 8000, "date": "2026-09-28"},
            ],
            "payments": [
                {"payment_id": "pay-9001", "payment_number": "PMT-9001", "customer_id": CUSTOMER_ID, "amount": 50000, "reference_number": "PO-170", "invoice_numbers": "INV-2201", "date": "2026-09-30"},
            ],
        },
        "sheets": {"rows": [
            {"row": 2, "po_ref": "PO-170", "customer": "Example Customer Pvt Ltd", "item": "Model X", "qty_ordered": 50, "qty_delivered": 50, "qty_pending": 0, "updated_at": "2026-09-18T10:00:00+05:30"},
        ]},
        "drive": {"docs": [
            {"id": "drv-policy-1", "name": "Billing policy - Example Customer Pvt Ltd", "text": "Billing policy: invoice the delivered quantity at the PO rate once goods are dispatched. Partial invoicing is permitted. Do not invoice undelivered balance."},
            {"id": "drv-rates-1", "name": "Rate card FY26-27", "text": "Model X Rs 1,000 per unit. Model Y Rs 800 per unit."},
        ]},
        "gmail": {"messages": [
            {"id": "gm-0001", "history_id": 1, "thread_id": "t-0001", "from": "newsletter@steelprices.in", "to": "accounts@demo-mfg.in", "subject": "Weekly steel price update",
             "date": "2026-10-01T09:00:00+05:30", "text": "HR coil prices steady this week.", "attachments": []},
        ], "sent": []},
        "whatsapp": {"sent": []},
        "bank": {"rows": [
            {"id": "bank-1", "date": "2026-09-30", "narration": "NEFT CR EXAMPLE CUSTOMER PVT LTD INV-2201 PO-170", "reference": "N273026001", "credit": 50000.0, "debit": 0.0, "balance": 450000.0},
        ]},
    }


async def seed(reset_connectors: bool = False) -> str:
    """Idempotent; safe when API and worker start at the same time (retries on a concurrent insert)."""
    from sqlalchemy.exc import IntegrityError

    for attempt in range(3):
        try:
            return await _seed(reset_connectors)
        except IntegrityError:
            if attempt == 2:
                raise
    raise RuntimeError("unreachable")


async def _seed(reset_connectors: bool = False) -> str:
    s_ = get_settings()
    async with session_scope() as s:
        t = (await s.execute(select(Tenant).where(Tenant.slug == s_.default_tenant_slug))).scalar_one_or_none()
        if t is None:
            t = Tenant(name="Demo Manufacturing Pvt Ltd", slug=s_.default_tenant_slug, case_seq=1041)
            s.add(t)
            await s.flush()
        for email, name, role in DEMO_USERS:
            u = (await s.execute(select(User).where(User.email == email))).scalar_one_or_none()
            if u is None:
                s.add(User(tenant_id=t.id, email=email, name=name, role=role, password_hash=hash_password("demo1234")))
        data = mock_datasets()
        for name in CONNECTOR_NAMES:
            c = (await s.execute(select(Connector).where(Connector.tenant_id == t.id, Connector.name == name))).scalar_one_or_none()
            if c is None:
                c = Connector(tenant_id=t.id, name=name, status="disconnected", mode="mock" if s_.demo_mode else "live", config={})
                s.add(c)
            if s_.demo_mode and (reset_connectors or not (c.config or {})):
                c.mode = "mock"
                c.status = "disconnected"
                c.authorized_by = None
                c.authorized_at = None
                c.cursor = {}
                d = data.get(name, {})
                c.config = {"rows": d["rows"]} if name == "bank" else {"mock": d}
        from ..flags import get_flag

        rules = await get_flag(s, t.id, "billing_rules", None)
        if not rules or "default" not in rules:  # keep customer-specific rules (e.g. bill N days after delivery)
            await set_flag(s, t.id, "billing_rules", {**(rules or {}), "default": {"mode": "on_delivery", "delay_days": 0, "allow_partial": True}})
        return t.id
