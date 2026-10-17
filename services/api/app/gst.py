"""GST invoice preview (deterministic, Decimal) + Indian money formatting.

- CGST + SGST (half each) when seller and buyer are in the same state (first two GSTIN digits), IGST otherwise.
- Rate from the item master (settings.items[name].rate), default settings.gst_default_rate (18).
- Round-off to the nearest rupee, total in Indian words (lakh / crore).
- IRN note when the tenant's annual turnover is at/above the e-invoice threshold (note only, no IRN API call).
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Any

TWO = Decimal("0.01")

STATE_NAMES = {
    "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana",
    "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland",
    "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand",
    "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu",
    "27": "Maharashtra", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
    "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
}


def D(v: Any) -> Decimal:
    if isinstance(v, Decimal):
        return v
    if v is None or v == "":
        return Decimal(0)
    return Decimal(str(v).replace(",", "").replace("₹", "").strip())


def num(v: Decimal) -> int | float:
    """JSON number: int when whole rupees, else 2-dp float."""
    q = v.quantize(TWO, rounding=ROUND_HALF_UP)
    return int(q) if q == q.to_integral_value() else float(q)


# ------------------------------------------------------------------ Indian formatting
def indian_digits(n: Any) -> str:
    """482000 -> '4,82,000'; 12345678.5 -> '1,23,45,678.50'."""
    d = D(n).quantize(TWO, rounding=ROUND_HALF_UP)
    neg = d < 0
    d = abs(d)
    whole = int(d)
    frac = d - whole
    s = str(whole)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        s = ",".join(parts) + "," + tail
    if frac:
        s += f".{int((frac * 100).to_integral_value()):02d}"
    return ("-" if neg else "") + s


def inr(n: Any) -> str:
    return "₹" + indian_digits(n)


_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen",
         "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _two(n: int) -> str:
    if n < 20:
        return _ONES[n]
    return (_TENS[n // 10] + (" " + _ONES[n % 10] if n % 10 else "")).strip()


def _three(n: int) -> str:
    h, r = divmod(n, 100)
    out = []
    if h:
        out.append(_ONES[h] + " Hundred")
    if r:
        out.append(_two(r))
    return " ".join(out)


def words_indian(n: Any) -> str:
    """82600 -> 'Rupees Eighty Two Thousand Six Hundred Only' (Indian system: thousand, lakh, crore)."""
    d = D(n).quantize(TWO, rounding=ROUND_HALF_UP)
    rupees = int(d)
    paise = int(((d - rupees) * 100).to_integral_value())
    if rupees == 0 and paise == 0:
        return "Rupees Zero Only"
    parts = []
    crore, rem = divmod(rupees, 10_000_000)
    lakh, rem = divmod(rem, 100_000)
    thousand, rem = divmod(rem, 1000)
    if crore:
        parts.append((words_indian(crore)[7:-5] if crore >= 100 else _two(crore)) + " Crore")
    if lakh:
        parts.append(_two(lakh) + " Lakh")
    if thousand:
        parts.append(_two(thousand) + " Thousand")
    if rem:
        parts.append(_three(rem))
    s = "Rupees " + " ".join(p for p in parts if p).strip() if parts else "Rupees Zero"
    if paise:
        s += f" and {_two(paise)} Paise"
    return s + " Only"


# ------------------------------------------------------------------ GST
def state_code(gstin: str | None) -> str | None:
    if gstin and len(gstin) >= 2 and gstin[:2].isdigit():
        return gstin[:2]
    return None


def item_tax(item: str, settings: dict[str, Any]) -> tuple[str, Decimal]:
    master = settings.get("items") or {}
    key = next((k for k in master if k.strip().lower() == (item or "").strip().lower()), None)
    rec = master.get(key, {}) if key else {}
    rate = D(rec.get("rate", settings.get("gst_default_rate", 18)))
    return str(rec.get("hsn") or settings.get("default_hsn") or ""), rate


def gst_preview(line_items: list[dict[str, Any]], settings: dict[str, Any], buyer_gstin: str | None,
                buyer_state_code: str | None = None) -> dict[str, Any]:
    """line_items: [{item, qty, rate}] (taxable rate, excl. GST). Returns the CONTRACT_V2 GstPreview + `rate` + `tax_total`."""
    company = settings.get("company") or {}
    seller_gstin = company.get("gstin") or None
    seller_state = company.get("state_code") or state_code(seller_gstin)
    buyer_state = state_code(buyer_gstin) or buyer_state_code or seller_state
    intra = seller_state is not None and seller_state == buyer_state
    lines, taxable_total, cgst, sgst, igst = [], Decimal(0), Decimal(0), Decimal(0), Decimal(0)
    rates = set()
    for li in line_items:
        qty, rate = D(li.get("qty")), D(li.get("rate"))
        taxable = (qty * rate).quantize(TWO, rounding=ROUND_HALF_UP)
        hsn, pct = item_tax(li.get("item") or "", settings)
        rates.add(pct)
        tax = (taxable * pct / 100).quantize(TWO, rounding=ROUND_HALF_UP)
        if intra:
            half = (tax / 2).quantize(TWO, rounding=ROUND_HALF_UP)
            cgst += half
            sgst += tax - half
        else:
            igst += tax
        taxable_total += taxable
        lines.append({"item": li.get("item") or "Item", "hsn": hsn, "qty": num(qty), "rate": num(rate), "taxable": num(taxable), "gst_rate": num(pct)})
    exact = taxable_total + cgst + sgst + igst
    total = exact.quantize(Decimal(1), rounding=ROUND_HALF_UP)
    round_off = total - exact
    irn_note = None
    threshold = settings.get("einvoice_turnover_threshold")
    turnover = settings.get("annual_turnover")
    if buyer_gstin and threshold is not None and turnover is not None and D(turnover) >= D(threshold):
        irn_note = (f"Your yearly turnover is above {inr(threshold)}, so this B2B invoice may need an e-invoice (IRN). "
                    "Generate the IRN in Zoho or the GST portal; RevenueGuard does not call the IRN API.")
    return {
        "seller_gstin": seller_gstin,
        "buyer_gstin": buyer_gstin,
        "place_of_supply": f"{buyer_state}-{STATE_NAMES.get(buyer_state, '')}".rstrip("-") if buyer_state else None,
        "lines": lines,
        "taxable": num(taxable_total),
        "cgst": num(cgst), "sgst": num(sgst), "igst": num(igst),
        "tax_total": num(cgst + sgst + igst),
        "round_off": num(round_off),
        "total": int(total),
        "total_words": words_indian(total),
        "irn_note": irn_note,
        "rate": num(max(rates)) if rates else num(D(settings.get("gst_default_rate", 18))),
    }


def gst_for_payload(preview: dict[str, Any]) -> dict[str, Any]:
    """The tax block bound into the approval payload hash (no prose fields)."""
    return {k: preview[k] for k in ("seller_gstin", "buyer_gstin", "place_of_supply", "lines", "taxable", "cgst", "sgst", "igst",
                                    "tax_total", "round_off", "total", "rate")}
