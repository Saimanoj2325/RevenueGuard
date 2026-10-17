"""Ask: read-only, deterministic intent router over the same queries the screens use.

Every number in an answer comes from load_world / case facts (validator) and carries a proof or a link.
Write requests are refused: action chips only open the existing approval flows.
"""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy import or_, select

from .business import bill_rows, case_summary, chase_rows, customer_stats, fuzzy_customer, load_world, to_int
from .db import session_scope
from .gst import inr
from .models import Case
from .validator import normalize_ref

WRITE_RE = re.compile(
    r"(?i)^\s*(please\s+|kindly\s+|can you\s+|could you\s+)?(approve|send|create|raise|make|mark|delete|cancel|void|issue|generate|record|update|change|edit|"
    r"email|whatsapp|remind|pay|reject|write|post|book|close)\b|\b(mark\b.*\b(paid|closed)|send\b.*\breminder|create\b.*\binvoice|raise\b.*\binvoice)\b")
TXT = {
    "en": {
        "refuse": "I can only look things up. To bill or send a reminder, use the Approve or Draft reminder buttons; they go through the normal approval.",
        "receivables": "{n} invoices, {amt} {what}{cond}.",
        "unbilled": "{n} deliveries are not billed yet: {amt}.",
        "nothing": "Nothing found{cond}.",
        "help": "I can answer: money to collect (e.g. 'receivables over 1 lakh'), deliveries not billed, why a PO was not billed, or a customer.",
        "customer": "{name}: outstanding {out}, overdue {od}, pays in {avg} days on {terms}-day terms ({risk}).",
        "no_case": "I could not find {po} in your cases.",
    },
    "hi": {
        "refuse": "मैं सिर्फ़ जानकारी देख सकता हूँ। बिल या रिमाइंडर के लिए Approve या Draft reminder बटन इस्तेमाल करें; वे सामान्य मंज़ूरी से गुज़रते हैं।",
        "receivables": "{n} बिल, {amt} {what}{cond}।",
        "unbilled": "{n} डिलीवरी का बिल अभी नहीं बना: {amt}।",
        "nothing": "कुछ नहीं मिला{cond}।",
        "help": "मैं बता सकता हूँ: वसूली (जैसे '1 लाख से ज़्यादा बकाया'), बिना बिल की डिलीवरी, किसी PO का बिल क्यों नहीं बना, या कोई ग्राहक।",
        "customer": "{name}: बकाया {out}, देर से {od}, {terms} दिन की शर्त पर {avg} दिन में भुगतान ({risk})।",
        "no_case": "{po} आपके केस में नहीं मिला।",
    },
    "te": {
        "refuse": "నేను సమాచారం మాత్రమే చూడగలను. బిల్లు లేదా రిమైండర్ కోసం Approve లేదా Draft reminder బటన్ వాడండి; అవి సాధారణ ఆమోదం ద్వారా వెళ్తాయి.",
        "receivables": "{n} బిల్లులు, {amt} {what}{cond}.",
        "unbilled": "{n} డెలివరీలకు ఇంకా బిల్లు వేయలేదు: {amt}.",
        "nothing": "ఏమీ దొరకలేదు{cond}.",
        "help": "నేను చెప్పగలను: వసూలు (ఉదా. '1 లక్ష పైగా బాకీ'), బిల్లు వేయని డెలివరీలు, ఒక PO ఎందుకు బిల్లు కాలేదు, లేదా ఒక కస్టమర్.",
        "customer": "{name}: బాకీ {out}, ఆలస్యం {od}, {terms} రోజుల గడువుపై {avg} రోజుల్లో చెల్లిస్తారు ({risk}).",
        "no_case": "{po} మీ కేసుల్లో దొరకలేదు.",
    },
}
WHAT = {"en": {"overdue": "overdue", "open": "to collect"}, "hi": {"overdue": "देर से", "open": "वसूली बाकी"}, "te": {"overdue": "ఆలస్యం", "open": "వసూలు బాకీ"}}


def parse_amount(q: str) -> int | None:
    best = None
    for m in re.finditer(r"(?i)(?:₹|rs\.?|inr)?\s*([\d][\d,]*(?:\.\d+)?)\s*(lakhs?|lac|l\b|k\b|thousand|crores?|cr\b|लाख|లక్ష\w*)?", q):
        raw, unit = m.group(1), (m.group(2) or "").lower()
        if re.fullmatch(r"\d{1,3}", raw.replace(",", "")) and not unit:
            # small bare numbers are days or PO numbers, not money
            continue
        v = float(raw.replace(",", ""))
        mult = 100000 if unit.startswith(("lakh", "lac", "l", "लाख", "లక్ష")) else 1000 if unit in ("k", "thousand") else 10_000_000 if unit.startswith(("crore", "cr")) else 1
        best = int(v * mult)
        break
    return best


def parse_days(q: str) -> int | None:
    m = re.search(r"(?i)(\d{1,3})\s*(?:\+\s*)?days?", q)
    return int(m.group(1)) if m else None


async def ask(tenant_id: str, question: str, lang: str | None = "en") -> dict[str, Any]:
    lang = lang if lang in TXT else "en"
    t = TXT[lang]
    q = (question or "").strip()
    if not q:
        return {"answer": t["help"], "table": None, "proofs": [], "actions": [], "intent": "help"}
    if WRITE_RE.search(q):
        return {"answer": t["refuse"], "table": None, "proofs": [], "intent": "refused_write",
                "actions": [{"label": "Open approvals", "href": "/approvals"}, {"label": "Open To bill", "href": "/bill"}, {"label": "Open To collect", "href": "/collect"}]}
    ql = q.lower()
    async with session_scope() as s:
        w = await load_world(s, tenant_id)
        # ---- PO lookup / why not billed
        m = re.search(r"(?i)\b(?:p\.?\s?o\.?)\s*[-#: ]?\s*(\d{1,7})\b", q)
        if m:
            norm = normalize_ref(f"PO{m.group(1)}")
            case = (await s.execute(select(Case).where(Case.tenant_id == tenant_id, Case.po_ref_norm == norm).order_by(Case.created_at.desc()))).scalars().first()
            if case is None:
                return {"answer": t["no_case"].format(po=f"PO-{int(m.group(1))}"), "table": None, "proofs": [], "actions": [{"label": "Open Unlinked", "href": "/unlinked"}], "intent": "case_lookup"}
            sm = await case_summary(s, case, lang)
            proofs = [f_["source"] for f_ in sm["facts"] if f_.get("source") and f_["source"].get("node_id")]
            return {"answer": f"{sm['headline']} {sm['recommendation']}",
                    "table": {"columns": ["Fact", "Value"], "rows": [[f_["label"], f_["value"] + (f" (was {f_['changed_from']})" if f_.get("changed_from") else "")] for f_ in sm["facts"]]},
                    "proofs": proofs[:6], "actions": [{"label": f"Open {case.case_number}", "href": f"/case?id={case.case_number}"}], "intent": "case_lookup", "case_ref": case.case_number}
        # ---- invoice lookup
        m = re.search(r"(?i)\bINV[-\s]?(\d{2,7})\b", q)
        if m:
            num = f"INV-{m.group(1)}"
            inv = next((i for i in w.invoices if (i.get("invoice_number") or "").upper() == num), None)
            if inv:
                bal, due = w.balance(inv), w.due_date(inv)
                late = max(0, (w.today - due).days) if due else 0
                ans = f"{num} for {inv.get('customer_name')}: total {inr(inv.get('total') or 0)}, unpaid {inr(to_int(bal))}" + (f", {late} days late." if bal > 0 and late else ".")
                return {"answer": ans, "table": {"columns": ["Invoice", "Customer", "Total", "Unpaid", "Due"], "rows": [[num, inv.get("customer_name"), to_int(inv.get("total")), to_int(bal), due.isoformat() if due else None]]},
                        "proofs": [{"kind": "zoho", "label": num, "node_id": None}], "actions": [{"label": "Open To collect", "href": "/collect"}], "intent": "invoice_lookup"}
        # ---- unbilled
        if re.search(r"(?i)unbilled|not billed|to bill|bill today|not invoiced|haven'?t billed|delivered but|बिल नहीं|బిల్లు వేయని|బిల్లు కాని", q):
            rows = bill_rows(w)
            amt = parse_amount(q)
            if amt:
                rows = [r for r in rows if r["amount"] > amt]
            nb = [r for r in rows if r["status"] != "scheduled"]
            ans = t["unbilled"].format(n=len(nb), amt=inr(sum(r["amount"] for r in nb))) if nb else t["nothing"].format(cond="")
            return {"answer": ans, "intent": "unbilled",
                    "table": {"columns": ["Customer", "PO", "What happened", "Status", "Amount"], "rows": [[r["customer"], r["po_ref"], r["headline"], r["status"], r["amount"]] for r in rows]},
                    "proofs": [p for r in rows for p in r["proofs"][:1]][:8],
                    "actions": [{"label": "Open To bill", "href": "/bill"}] + [{"label": f"Review {r['po_ref']}", "href": f"/case?id={r['case_ref']}"} for r in rows[:2]]}
        # ---- receivables
        if re.search(r"(?i)receivable|outstanding|owe|overdue|collect|payment|late|due|बकाया|वसूली|బాకీ|వసూలు", q):
            amt = parse_amount(q)
            days = parse_days(q)
            overdue_only = bool(re.search(r"(?i)overdue|late|days|देर|ఆలస్యం", q))
            if overdue_only:
                rows = [{"customer": r["customer"], "invoice": r["invoice_number"], "amount": r["amount"], "days_late": r["days_late"], "customer_id": r["customer_id"]} for r in chase_rows(w)]
            else:
                rows = []
                for inv in w.invoices:
                    bal = w.balance(inv)
                    if bal <= 0 or inv.get("status") == "void":
                        continue
                    due = w.due_date(inv)
                    rows.append({"customer": inv.get("customer_name"), "invoice": inv.get("invoice_number"), "amount": to_int(bal),
                                 "days_late": max(0, (w.today - due).days) if due else 0, "customer_id": inv.get("customer_id")})
            if amt:
                rows = [r for r in rows if r["amount"] > amt]
            if days:
                rows = [r for r in rows if r["days_late"] >= days]
            rows.sort(key=lambda r: -r["amount"])
            cond = (f" over {inr(amt)}" if amt else "") + (f", {days}+ days late" if days else "")
            if not rows:
                return {"answer": t["nothing"].format(cond=cond), "table": None, "proofs": [], "actions": [{"label": "Open To collect", "href": "/collect"}], "intent": "receivables"}
            ans = t["receivables"].format(n=len(rows), amt=inr(sum(r["amount"] for r in rows)), what=WHAT[lang]["overdue" if overdue_only else "open"], cond=cond)
            return {"answer": ans, "intent": "receivables",
                    "table": {"columns": ["Customer", "Invoice", "Amount", "Days late"], "rows": [[r["customer"], r["invoice"], r["amount"], r["days_late"]] for r in rows]},
                    "proofs": [{"kind": "zoho", "label": r["invoice"], "node_id": None} for r in rows[:8]],
                    "actions": [{"label": "Open To collect", "href": "/collect"}] + ([{"label": f"Draft reminder for {rows[0]['invoice']}", "href": f"/collect?invoice={rows[0]['invoice']}"}] if overdue_only else [])}
        # ---- customer lookup
        names = sorted({c.get("contact_name") for c in w.contacts if c.get("contact_name")} | {cv.customer for cv in w.cases if cv.customer})
        phrase, canon, _sc = fuzzy_customer(q, names)
        if canon:
            ct = w.contact_by_name(canon)
            cid = ct["contact_id"] if ct else next((cv.customer_id for cv in w.cases if cv.customer == canon), None)
            st = customer_stats(w, cid) if cid else None
            if st:
                ans = t["customer"].format(name=canon, out=inr(st["outstanding"]), od=inr(st["overdue"]), avg=st["avg_days_to_pay"] if st["avg_days_to_pay"] is not None else "-",
                                           terms=st["terms_days"], risk=st["risk"])
                rows = [[r["po_ref"], r["status"], r["amount"]] for r in bill_rows(w, customer=cid)]
                return {"answer": ans, "intent": "customer", "table": {"columns": ["PO", "Status", "Amount"], "rows": rows} if rows else None,
                        "proofs": [], "actions": [{"label": f"Open {canon}", "href": f"/customers?id={cid}"}]}
    return {"answer": t["help"], "table": None, "proofs": [], "actions": [{"label": "Open Today", "href": "/"}], "intent": "help"}
