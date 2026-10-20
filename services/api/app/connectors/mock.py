"""DEMO_MODE mock adapters. State lives in connectors.config['mock'] (Postgres) so API and worker share it.
They honour chaos flags (zoho_down, zoho_timeout_once) so failure handling is exercised for real."""
from __future__ import annotations

import copy
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import or_, select

from ..flags import chaos_on, set_flag
from ..models import Connector, WaMessage
from ..validator import normalize_ref, refs_match, text_mentions_ref
from .base import (
    BankAdapter,
    ConnectorTimeout,
    ConnectorUnavailable,
    DriveAdapter,
    GmailAdapter,
    SheetsAdapter,
    WhatsAppAdapter,
    ZohoAdapter,
)

FIXTURE_DIR = Path(__file__).resolve().parent.parent / "demo" / "fixtures"


def _mock(conn: Connector) -> dict[str, Any]:
    return copy.deepcopy((conn.config or {}).get("mock") or {})


def _save(conn: Connector, data: dict[str, Any]) -> None:
    cfg = dict(conn.config or {})
    cfg["mock"] = data
    conn.config = cfg  # reassign so SQLAlchemy detects the JSON change


def _q_match(text: str, query: str) -> bool:
    """Gmail-ish query: terms ANDed; a PO-like term matches all its spellings."""
    text_l = (text or "").lower()
    for term in [t for t in (query or "").replace('"', " ").split() if ":" not in t or t.lower().startswith("po")]:
        if normalize_ref(term) and any(c.isdigit() for c in term):
            if not (text_mentions_ref(text, term) or term.lower() in text_l):
                return False
        elif term.lower() not in text_l:
            return False
    return True


class MockGmail(GmailAdapter):
    def __init__(self, session, conn: Connector):
        self.session, self.conn = session, conn

    async def list_new_messages(self, cursor):
        m = _mock(self.conn)
        last = int((cursor or {}).get("history_id", 0))
        msgs = [x for x in m.get("messages", []) if int(x.get("history_id", 0)) > last]
        new_last = max([last] + [int(x.get("history_id", 0)) for x in msgs])
        return [self._hydrate(x) for x in msgs], {"history_id": new_last}

    def _hydrate(self, x: dict[str, Any]) -> dict[str, Any]:
        out = dict(x)
        atts = []
        for a in x.get("attachments", []):
            a = dict(a)
            if a.get("fixture"):
                p = FIXTURE_DIR / a["fixture"]
                if p.exists():
                    a["data"] = p.read_bytes()
            atts.append(a)
        out["attachments"] = atts
        return out

    async def search(self, query, limit=20):
        m = _mock(self.conn)
        hits = [x for x in m.get("messages", []) if _q_match(f"{x.get('subject','')}\n{x.get('text','')}", query)]
        return [{k: v for k, v in x.items() if k != "attachments"} | {"attachment_names": [a["filename"] for a in x.get("attachments", [])]} for x in hits[:limit]]

    async def send(self, to, subject, body, idempotency_key):
        m = _mock(self.conn)
        sent = m.setdefault("sent", [])
        for s in sent:
            if s["idempotency_key"] == idempotency_key:
                return s["id"]
        mid = f"mock-sent-{len(sent) + 1}"
        sent.append({"id": mid, "to": to, "subject": subject, "body": body, "idempotency_key": idempotency_key})
        _save(self.conn, m)
        return mid


class MockSheets(SheetsAdapter):
    def __init__(self, session, conn: Connector):
        self.session, self.conn = session, conn

    async def read_delivery(self, ref=None):
        m = _mock(self.conn)
        rows = m.get("rows", [])
        if m.get("raw"):  # a raw grid (user-shaped headers) is read through the confirmed column mapping
            from ..sheet_mapping import apply_mapping

            rows = rows + apply_mapping(m["raw"], (self.conn.config or {}).get("mapping"))
        return [r for r in rows if ref is None or refs_match(r.get("po_ref"), ref)]

    async def read_raw(self, sheet_id=None, tab=None, limit=21):
        """Header + first rows as the user typed them (for the smart column mapping)."""
        m = _mock(self.conn)
        if m.get("raw"):
            return m["raw"][:limit]
        head = ["PO No", "Party", "Model", "Qty", "Disp.", "Bal", "Dispatch dt", "Remarks"]
        grid = [head]
        for r in m.get("rows", [])[: limit - 1]:
            grid.append([r.get("po_ref"), r.get("customer"), r.get("item"), r.get("qty_ordered"), r.get("qty_delivered"), r.get("qty_pending"),
                         (re.search(r"\d{4}-\d{2}-\d{2}", str(r.get("updated_at") or "")) or re.search("", "")).group(0), ""])
        return grid

    async def list_files(self, limit=30):
        return [{"id": "1YqDispatchRegister2026", "name": "Dispatch Register", "modified_at": "2026-10-20T09:00:00Z"},
                {"id": "1YqPartyLedger2026", "name": "Party ledger 2026-27", "modified_at": "2026-10-18T09:00:00Z"}][:limit]

    async def list_tabs(self, sheet_id):
        grid = await self.read_raw(sheet_id, None, 2)
        return {"title": "Dispatch Register" if sheet_id == "1YqDispatchRegister2026" else "Party ledger 2026-27",
                "tabs": [{"title": "Sep", "rows": 120, "header": grid[0] if grid else []},
                         {"title": "Oct", "rows": 214, "header": grid[0] if grid else []},
                         {"title": "Notes", "rows": 20, "header": ["Note"]}]}


class MockDrive(DriveAdapter):
    def __init__(self, session, conn: Connector):
        self.session, self.conn = session, conn

    async def search_docs(self, query, limit=5):
        docs = _mock(self.conn).get("docs", [])
        terms = [t.lower() for t in (query or "").split()]
        scored = []
        for d in docs:
            hay = (d.get("name", "") + " " + d.get("text", "")).lower()
            score = sum(1 for t in terms if t in hay)
            if score or not terms:
                scored.append((score, d))
        scored.sort(key=lambda x: -x[0])
        return [d for _, d in scored[:limit]]


class MockZoho(ZohoAdapter):
    def __init__(self, session, conn: Connector, tenant_id: str):
        self.session, self.conn, self.tenant_id = session, conn, tenant_id

    async def _check(self):
        if await chaos_on(self.session, self.tenant_id, "zoho_down"):
            raise ConnectorUnavailable("zoho", "Zoho Books API unreachable (HTTP 503)")

    async def list_contacts(self, search=None):
        await self._check()
        cs = _mock(self.conn).get("contacts", [])
        return [c for c in cs if not search or search.lower() in c.get("contact_name", "").lower()]

    async def list_salesorders(self, search=None):
        await self._check()
        sos = _mock(self.conn).get("salesorders", [])
        return [s for s in sos if not search or refs_match(s.get("reference_number"), search) or refs_match(s.get("salesorder_number"), search)]

    async def list_invoices(self, search=None, customer_id=None):
        await self._check()
        inv = _mock(self.conn).get("invoices", [])
        out = []
        for i in inv:
            if customer_id and i.get("customer_id") != customer_id:
                continue
            if search and not (
                refs_match(i.get("reference_number"), search)
                or refs_match(i.get("invoice_number"), search)
                or search.lower() in (i.get("customer_name", "").lower())
                or text_mentions_ref(i.get("notes", ""), search)
            ):
                continue
            out.append(i)
        return out

    async def list_creditnotes(self, search=None):
        await self._check()
        cns = _mock(self.conn).get("creditnotes", [])
        return [c for c in cns if not search or refs_match(c.get("reference_number"), search) or search.lower() in c.get("customer_name", "").lower()]

    async def list_payments(self, search=None):
        await self._check()
        ps = _mock(self.conn).get("payments", [])
        return [p for p in ps if not search or refs_match(p.get("reference_number"), search) or search.lower() in p.get("invoice_numbers", "").lower()]

    async def find_invoices_by_reference(self, reference):
        await self._check()
        return [i for i in _mock(self.conn).get("invoices", []) if refs_match(i.get("reference_number"), reference)]

    async def create_invoice(self, payload, idempotency_key):
        await self._check()
        await self.session.refresh(self.conn, with_for_update=True)  # serialize writers to the mock ledger
        m = _mock(self.conn)
        invs = m.setdefault("invoices", [])
        seq = int(m.get("seq", 2300)) + 1
        m["seq"] = seq
        contact = next((c for c in m.get("contacts", []) if c["contact_id"] == payload.get("customer_id")), None)
        if contact is None:
            raise ConnectorUnavailable("zoho", f"customer {payload.get('customer_id')} not found", retryable=False)
        line_items = [
            {"name": li.get("name") or li.get("item"), "quantity": li["quantity"], "rate": li["rate"], "item_total": round(li["quantity"] * li["rate"], 2)}
            for li in payload.get("line_items", [])
        ]
        sub_total = round(sum(li["item_total"] for li in line_items), 2)
        tax_total = 0.0
        for li, src in zip(line_items, payload.get("line_items", [])):
            if src.get("tax_percentage"):
                li["tax_percentage"] = src["tax_percentage"]
                li["hsn_or_sac"] = src.get("hsn_or_sac")
                tax_total += round(li["item_total"] * float(src["tax_percentage"]) / 100, 2)
        exact = sub_total + tax_total
        total = float(round(exact)) if tax_total else sub_total
        inv = {
            "invoice_id": f"mock-inv-{seq}",
            "invoice_number": f"INV-{seq}",
            "customer_id": payload["customer_id"],
            "customer_name": contact["contact_name"],
            "reference_number": payload.get("reference_number"),
            "date": payload.get("date") or datetime.now(timezone.utc).date().isoformat(),
            "status": "draft",
            "line_items": line_items,
            "sub_total": sub_total,
            "tax_total": round(tax_total, 2),
            "adjustment": round(total - exact, 2) if tax_total else 0.0,
            "place_of_supply": payload.get("place_of_supply"),
            "total": total,
            "balance": total,
            "due_date": (datetime.fromisoformat(payload.get("date") or datetime.now(timezone.utc).date().isoformat()) + timedelta(days=30)).date().isoformat(),
            "notes": payload.get("notes", ""),
            "custom_fields": [{"api_name": "cf_rg_idempotency_key", "value": idempotency_key}],
        }
        invs.append(inv)
        _save(self.conn, m)
        if await chaos_on(self.session, self.tenant_id, "zoho_timeout_once"):
            await set_flag(self.session, self.tenant_id, "chaos:zoho_timeout_once", False)
            raise ConnectorTimeout("zoho", "timeout after write was sent")
        return inv

    async def get_invoice(self, invoice_id):
        await self._check()
        return next((i for i in _mock(self.conn).get("invoices", []) if i["invoice_id"] == invoice_id), None)


class MockBank(BankAdapter):
    def __init__(self, session, conn: Connector):
        self.session, self.conn = session, conn

    async def payments(self, ref=None, amount=None):
        rows = (self.conn.config or {}).get("rows", [])
        out = []
        for r in rows:
            if ref and not (text_mentions_ref(r.get("narration", ""), ref) or refs_match(r.get("reference"), ref)):
                continue
            if amount is not None and abs(float(r.get("credit") or 0) - float(amount)) > 0.009:
                continue
            out.append(r)
        return out


class MockWhatsApp(WhatsAppAdapter):
    def __init__(self, session, conn: Connector, tenant_id: str):
        self.session, self.conn, self.tenant_id = session, conn, tenant_id

    async def search(self, q=None, chat=None, since=None):
        stmt = select(WaMessage).where(WaMessage.tenant_id == self.tenant_id)
        if chat:
            stmt = stmt.where(WaMessage.chat_id == chat)
        rows = (await self.session.execute(stmt.order_by(WaMessage.ts))).scalars().all()
        out = []
        for r in rows:
            text = (r.text or "") + "\n" + (r.derived_text or "")
            if q and not _q_match(text, q):
                continue
            out.append({"id": r.message_id, "chat_id": r.chat_id, "from_name": r.from_name, "ts": r.ts.isoformat(), "text": r.text, "derived_text": r.derived_text, "media_mime": r.media_mime})
        return out

    async def send(self, to, text, idempotency_key, approval_id):
        m = _mock(self.conn)
        sent = m.setdefault("sent", [])
        for s in sent:
            if s["idempotency_key"] == idempotency_key:
                return s["message_id"]
        mid = f"mock-wa-{len(sent) + 1}"
        sent.append({"message_id": mid, "to": to, "text": text, "idempotency_key": idempotency_key, "approval_id": approval_id})
        _save(self.conn, m)
        return mid

    async def lookup_send(self, idempotency_key):
        for x in _mock(self.conn).get("sent", []):
            if x["idempotency_key"] == idempotency_key:
                return {"status": "sent", "message_id": x["message_id"]}
        return None

    async def status(self):
        return {"state": "open", "me": {"id": "demo", "name": "RevenueGuard Demo (mock)"}}
