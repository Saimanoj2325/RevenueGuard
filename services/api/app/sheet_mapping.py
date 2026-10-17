"""Smart delivery-sheet column mapping: header synonyms first, value patterns second, LLM only as a last resort.
Each column gets a meaning (po_ref, customer, item, qty_ordered, qty_delivered, qty_pending, delivery_date, ignore)
and a confidence ("sure" from a synonym, "check" from a pattern or the LLM). The confirmed mapping is stored in the
sheets connector config and used by read_delivery (live and mock)."""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from pydantic import BaseModel

MEANINGS = ("po_ref", "customer", "item", "qty_ordered", "qty_delivered", "qty_pending", "delivery_date", "ignore")
SYNONYMS: dict[str, list[str]] = {
    "po_ref": ["po", "po no", "po number", "po ref", "po_ref", "po #", "order no", "order number", "purchase order", "reference", "ref no", "customer po"],
    "customer": ["customer", "customer name", "party", "party name", "buyer", "client", "consignee", "bill to", "dealer"],
    "item": ["item", "product", "model", "description", "material", "sku", "item name", "goods"],
    "qty_ordered": ["ordered", "order qty", "qty ordered", "po qty", "ordered qty", "quantity ordered", "qty_ordered", "order quantity"],
    "qty_delivered": ["delivered", "delivered qty", "qty delivered", "dispatched", "disp qty", "dispatch qty", "supplied", "shipped", "qty_delivered", "sent qty"],
    "qty_pending": ["pending", "balance", "bal", "bal qty", "pending qty", "remaining", "qty_pending", "balance qty"],
    "delivery_date": ["date", "delivery date", "dispatch date", "dc date", "challan date", "delivered on", "updated", "updated_at"],
}
_PO_RE = re.compile(r"^\s*(P\.?\s?O\.?|SO)?\s*[#:\-/ ]?\s*\d{2,7}\s*$", re.I)
_PO_STRICT = re.compile(r"(?i)^\s*(P\.?\s?O\.?|SO)\s*[#:\-/ ]?\s*\d{2,7}\s*$")
_COMPANY = re.compile(r"(?i)\b(pvt|ltd|llp|traders|industries|enterprises|works|foods|plastics|electricals|packaging|steel|agro)\b")


def norm_header(h: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9#_ ]", " ", (h or "").lower())).strip()


def _num(v: Any) -> float | None:
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _is_date(v: Any) -> bool:
    s = str(v or "").strip()
    if not s:
        return False
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y", "%d %b %Y", "%d-%b-%Y", "%d %b", "%d-%b-%y"):
        try:
            datetime.strptime(s[:11].strip(), fmt)
            return True
        except ValueError:
            continue
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}", s))


class _LlmCols(BaseModel):
    columns: dict[str, str]


async def propose(values: list[list[Any]], *, session=None, tenant_id: str | None = None, use_llm: bool = True) -> list[dict[str, Any]]:
    if not values:
        return []
    header = [str(h) for h in values[0]]
    rows = values[1:21]
    col_vals = [[r[i] for r in rows if i < len(r) and str(r[i]).strip() != ""] for i in range(len(header))]
    out: list[dict[str, Any]] = [{"header": h, "meaning": None, "confidence": "check", "sample": (str(col_vals[i][0]) if col_vals[i] else "")} for i, h in enumerate(header)]
    used: set[str] = set()
    # 1) header synonyms
    for i, h in enumerate(header):
        nh = norm_header(h)
        for meaning, syns in SYNONYMS.items():
            if meaning in used:
                continue
            if nh in syns or nh.replace(" ", "_") == meaning:
                out[i].update(meaning=meaning, confidence="sure")
                used.add(meaning)
                break
    # 2) value patterns
    numeric = []
    for i, c in enumerate(out):
        if c["meaning"]:
            continue
        vals = col_vals[i]
        if not vals:
            c.update(meaning="ignore", confidence="check")
            continue
        n = len(vals)
        if "po_ref" not in used and sum(bool(_PO_RE.match(str(v))) for v in vals) >= 0.8 * n and sum(bool(_PO_STRICT.match(str(v))) for v in vals) >= 0.5 * n:
            c.update(meaning="po_ref"); used.add("po_ref")
        elif "delivery_date" not in used and sum(_is_date(v) for v in vals) >= 0.8 * n:
            c.update(meaning="delivery_date"); used.add("delivery_date")
        elif all(_num(v) is not None for v in vals):
            numeric.append(i)
        elif "customer" not in used and sum(bool(_COMPANY.search(str(v))) for v in vals) >= 0.5 * n:
            c.update(meaning="customer"); used.add("customer")
        elif "item" not in used and len({str(v) for v in vals}) <= max(3, n // 2 + 1):
            c.update(meaning="item"); used.add("item")
    qty_roles = [m for m in ("qty_ordered", "qty_delivered", "qty_pending") if m not in used]
    if numeric and qty_roles:
        def series(i):
            return [_num(r[i]) if i < len(r) else None for r in rows]
        assigned = False
        if len(numeric) >= 3 and len(qty_roles) == 3:
            from itertools import permutations

            for a, b, c3 in permutations(numeric[:4], 3):
                sa, sb, sc = series(a), series(b), series(c3)
                pairs = [(x, y, z) for x, y, z in zip(sa, sb, sc) if None not in (x, y, z)]
                if pairs and all(abs(x - y - z) < 1e-6 for x, y, z in pairs) and all(x >= y for x, y, _ in pairs):
                    for idx, m in ((a, "qty_ordered"), (b, "qty_delivered"), (c3, "qty_pending")):
                        out[idx].update(meaning=m)
                        used.add(m)
                    assigned = True
                    break
        if not assigned:
            means = sorted(numeric, key=lambda i: -(sum(x for x in series(i) if x is not None) / max(1, len([x for x in series(i) if x is not None]))))
            for idx, m in zip(means, [r for r in ("qty_ordered", "qty_delivered") if r not in used]):
                out[idx].update(meaning=m)
                used.add(m)
    # 3) LLM last resort for anything still unknown (real providers only; demo mock answers "ignore")
    unknown = [c for c in out if not c["meaning"]]
    if unknown and use_llm:
        from .llm.router import get_llm

        prompt = ("Map each spreadsheet column header to one of: " + ", ".join(MEANINGS) + ". Return JSON {\"columns\": {header: meaning}}.\n"
                  + "\n".join(f"{c['header']}: e.g. {c['sample']!r}" for c in unknown))
        try:
            res = await get_llm().complete_structured("sheet_mapping", [{"role": "user", "content": prompt}], _LlmCols,
                                                      lambda: {"columns": {c["header"]: "ignore" for c in unknown}}, session=session, tenant_id=tenant_id, max_tokens=300)
            for c in unknown:
                m = res.data["columns"].get(c["header"], "ignore")
                c.update(meaning=m if m in MEANINGS and m not in used else "ignore", confidence="check")
                if c["meaning"] != "ignore":
                    used.add(c["meaning"])
        except Exception:  # noqa: BLE001
            pass
    for c in out:
        if not c["meaning"]:
            c.update(meaning="ignore", confidence="check")
    return out


def apply_mapping(values: list[list[Any]], mapping: dict[str, str] | None, keymap: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """Grid -> canonical delivery rows using the confirmed mapping first, then the built-in KEYMAP synonyms."""
    if not values:
        return []
    mapping = mapping or {}
    keymap = keymap or {}
    header = []
    for h in values[0]:
        hs = str(h).strip()
        m = mapping.get(hs) or mapping.get(hs.lower()) or keymap.get(hs.lower()) or next((k for k, syns in SYNONYMS.items() if norm_header(hs) in syns), None) or hs.lower()
        header.append(m)
    rows = []
    for i, v in enumerate(values[1:], start=2):
        row = {}
        for j in range(min(len(header), len(v))):
            if header[j] == "ignore":
                continue
            row[header[j]] = v[j]
        if "delivery_date" in row and "updated_at" not in row:
            row["updated_at"] = row["delivery_date"]
        row["row"] = i
        rows.append(row)
    return rows
