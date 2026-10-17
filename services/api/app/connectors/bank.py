"""Bank statement CSV import (both modes). Rows are stored on connectors.config['rows'] (tenant scoped)."""
from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Any

from ..models import Connector
from ..validator import text_mentions_ref, refs_match
from .base import BankAdapter

ALIASES = {
    "date": "date", "txn date": "date", "transaction date": "date", "value date": "date",
    "narration": "narration", "description": "narration", "particulars": "narration", "remarks": "narration",
    "reference": "reference", "ref no": "reference", "ref no./cheque no.": "reference", "utr": "reference", "chq/ref no": "reference",
    "credit": "credit", "deposit": "credit", "deposit amt.": "credit", "credit amount": "credit", "cr": "credit",
    "debit": "debit", "withdrawal": "debit", "withdrawal amt.": "debit", "dr": "debit",
    "balance": "balance", "closing balance": "balance",
}


def _num(v: Any) -> float:
    try:
        return float(str(v).replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def parse_bank_csv(raw: bytes) -> list[dict[str, Any]]:
    text = raw.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for i, r in enumerate(reader):
        norm = {ALIASES.get((k or "").strip().lower(), (k or "").strip().lower()): (v or "").strip() for k, v in r.items()}
        if not any(norm.values()):
            continue
        d = norm.get("date", "")
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d %b %Y"):
            try:
                d = datetime.strptime(d, fmt).date().isoformat()
                break
            except ValueError:
                continue
        rows.append({"id": f"bank-{i + 1}", "date": d, "narration": norm.get("narration", ""), "reference": norm.get("reference", ""),
                     "credit": _num(norm.get("credit")), "debit": _num(norm.get("debit")), "balance": _num(norm.get("balance"))})
    return rows


class CsvBank(BankAdapter):
    def __init__(self, session, conn: Connector):
        self.session, self.conn = session, conn

    async def payments(self, ref=None, amount=None):
        out = []
        for r in (self.conn.config or {}).get("rows", []):
            if not r.get("credit"):
                continue
            if ref and not (text_mentions_ref(r.get("narration", ""), ref) or refs_match(r.get("reference"), ref)):
                continue
            if amount is not None and abs(float(r["credit"]) - float(amount)) > 0.009:
                continue
            out.append(r)
        return out
