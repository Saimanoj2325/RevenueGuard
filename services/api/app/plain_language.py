"""Plain-language headlines, recommendations and team/customer message texts.

HARD RULE 4: every sentence here is a fixed template filled with numbers from the deterministic validator
(or Zoho/bank records). No LLM text is ever used. Languages: en, hi, te.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from .gst import inr, indian_digits

LANGS = ("en", "hi", "te")


def _lang(lang: str | None) -> str:
    return lang if lang in LANGS else "en"


def qty(v: Any) -> str:
    if v is None:
        return "?"
    try:
        f = float(v)
    except (TypeError, ValueError):
        return "?"  # e.g. a conflict that has only one reading
    return indian_digits(int(f)) if f == int(f) else str(round(f, 2))


def short_date(v: Any) -> str:
    """'2026-10-09...' -> '9 Oct'."""
    if v is None:
        return "?"
    if isinstance(v, str):
        try:
            v = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return v[:10]
    if isinstance(v, datetime):
        from zoneinfo import ZoneInfo

        if v.tzinfo:
            v = v.astimezone(ZoneInfo("Asia/Kolkata"))
        v = v.date()
    if isinstance(v, date):
        return f"{v.day} {v.strftime('%b')}"
    return str(v)


SOURCE_LABEL = {
    "en": {"whatsapp": "WhatsApp", "sheets": "Sheet", "gmail": "Email", "media": "Challan", "manual": "Your correction", "zoho": "Zoho", "bank": "Bank", "drive": "Drive"},
    "hi": {"whatsapp": "WhatsApp", "sheets": "शीट", "gmail": "ईमेल", "media": "चालान", "manual": "आपके सुधार", "zoho": "Zoho", "bank": "बैंक", "drive": "Drive"},
    "te": {"whatsapp": "WhatsApp", "sheets": "షీట్", "gmail": "ఈమెయిల్", "media": "చలాన్", "manual": "మీ సవరణ", "zoho": "Zoho", "bank": "బ్యాంక్", "drive": "Drive"},
}

HEADLINES = {
    "en": {
        "not_billed_full": "Delivered in full on {date}. No invoice in Zoho.",
        "not_billed_partial": "Delivered {delivered} of {ordered} {item}. Nothing billed.",
        "under_billed": "Delivered {delivered}, billed only {billed}.",
        "conflict": "{a_label} says {a}, {b_label} says {b}.",
        "scheduled": "Delivered. Terms say bill after {date}.",
        "duplicate": "Billed twice for {po}: {invoices}.",
        "partial_payment": "Paid {paid} of {total} on {invoice}.",
        "overdue": "{invoice} is {days} days late: {amount}.",
        "billed": "Billed on {invoice} ({amount}) and checked in Zoho.",
        "waiting_delivery": "Order received. No delivery seen yet.",
        "none": "Nothing to do.",
    },
    "hi": {
        "not_billed_full": "{date} को पूरा माल पहुँच गया। Zoho में कोई बिल नहीं।",
        "not_billed_partial": "{item} के {ordered} में से {delivered} पहुँचे। कोई बिल नहीं बना।",
        "under_billed": "{delivered} पहुँचे, बिल सिर्फ़ {billed} का बना।",
        "conflict": "{a_label} में {a}, {b_label} में {b} लिखा है।",
        "scheduled": "माल पहुँच गया। शर्तों के अनुसार {date} के बाद बिल बनेगा।",
        "duplicate": "{po} के लिए दो बिल बने हैं: {invoices}।",
        "partial_payment": "{invoice} पर {total} में से {paid} मिले।",
        "overdue": "{invoice} {days} दिन से बकाया है: {amount}।",
        "billed": "{invoice} ({amount}) बन गया और Zoho में जाँच हो गई।",
        "waiting_delivery": "ऑर्डर मिला। अभी डिलीवरी की खबर नहीं।",
        "none": "कुछ करने की ज़रूरत नहीं।",
    },
    "te": {
        "not_billed_full": "{date} న పూర్తి సరుకు చేరింది. Zohoలో బిల్లు లేదు.",
        "not_billed_partial": "{item} {ordered}లో {delivered} చేరాయి. ఇంకా బిల్లు వేయలేదు.",
        "under_billed": "{delivered} చేరాయి, బిల్లు {billed}కే వేశారు.",
        "conflict": "{a_label}లో {a}, {b_label}లో {b} అని ఉంది.",
        "scheduled": "సరుకు చేరింది. నిబంధనల ప్రకారం {date} తర్వాత బిల్లు వేయాలి.",
        "duplicate": "{po}కి రెండు బిల్లులు ఉన్నాయి: {invoices}.",
        "partial_payment": "{invoice}పై {total}లో {paid} వచ్చింది.",
        "overdue": "{invoice} {days} రోజులుగా బాకీ: {amount}.",
        "billed": "{invoice} ({amount}) వేశాం, Zohoలో సరిచూశాం.",
        "waiting_delivery": "ఆర్డర్ వచ్చింది. ఇంకా డెలివరీ సమాచారం లేదు.",
        "none": "చేయాల్సింది ఏమీ లేదు.",
    },
}

RECOMMENDATIONS = {
    "en": {
        "bill": "Bill {taxable} + GST {tax} = {total} to {customer} for {qty} × {item}.",
        "bill_rest": "Bill the missing {qty} units: {taxable} + GST {tax} = {total}.",
        "conflict": "Check the delivery count with the team before billing. We will not bill until it is clear.",
        "scheduled": "No action now. We will put it up for approval on {date}.",
        "duplicate": "Do not bill again. Check if one invoice should be cancelled with a credit note.",
        "partial_payment": "Ask {customer} for the balance {balance}.",
        "overdue": "Send a polite reminder with a UPI pay link.",
        "billed": "Nothing to do. We will watch for the payment.",
        "waiting_delivery": "No action yet. We will bill when the delivery is confirmed.",
        "none": "Nothing to do.",
    },
    "hi": {
        "bill": "{customer} को {qty} × {item} का बिल बनाएँ: {taxable} + GST {tax} = {total}।",
        "bill_rest": "बाकी {qty} यूनिट का बिल बनाएँ: {taxable} + GST {tax} = {total}।",
        "conflict": "बिल बनाने से पहले टीम से डिलीवरी की गिनती पक्की करें। साफ़ होने तक हम बिल नहीं बनाएँगे।",
        "scheduled": "अभी कुछ नहीं करना। {date} को हम इसे मंज़ूरी के लिए रखेंगे।",
        "duplicate": "दोबारा बिल न बनाएँ। देखें कि क्या एक बिल क्रेडिट नोट से रद्द करना है।",
        "partial_payment": "{customer} से बाकी {balance} माँगें।",
        "overdue": "UPI पे लिंक के साथ एक विनम्र याद दिलाने वाला संदेश भेजें।",
        "billed": "कुछ नहीं करना। हम भुगतान पर नज़र रखेंगे।",
        "waiting_delivery": "अभी कुछ नहीं। डिलीवरी पक्की होते ही हम बिल बनाएँगे।",
        "none": "कुछ नहीं करना।",
    },
    "te": {
        "bill": "{customer}కి {qty} × {item} బిల్లు వేయండి: {taxable} + GST {tax} = {total}.",
        "bill_rest": "మిగిలిన {qty} యూనిట్లకు బిల్లు వేయండి: {taxable} + GST {tax} = {total}.",
        "conflict": "బిల్లు వేసే ముందు టీమ్‌తో డెలివరీ లెక్క సరిచూసుకోండి. స్పష్టత వచ్చే వరకు మేము బిల్లు వేయం.",
        "scheduled": "ఇప్పుడు ఏమీ చేయనక్కర్లేదు. {date}న ఆమోదానికి పెడతాం.",
        "duplicate": "మళ్లీ బిల్లు వేయకండి. ఒక బిల్లును క్రెడిట్ నోట్‌తో రద్దు చేయాలేమో చూడండి.",
        "partial_payment": "{customer} నుండి మిగిలిన {balance} అడగండి.",
        "overdue": "UPI పే లింక్‌తో మర్యాదగా గుర్తు చేసే సందేశం పంపండి.",
        "billed": "ఏమీ చేయనక్కర్లేదు. చెల్లింపు కోసం గమనిస్తాం.",
        "waiting_delivery": "ఇప్పుడేమీ లేదు. డెలివరీ నిర్ధారణ కాగానే బిల్లు వేస్తాం.",
        "none": "ఏమీ చేయనక్కర్లేదు.",
    },
}

# exception type -> situation used when facts alone do not decide it
_TYPE_SITUATION = {
    "missing_invoice": "not_billed_partial",
    "partial_delivery": "not_billed_partial",
    "duplicate_invoice": "duplicate",
    "partial_payment": "partial_payment",
    "quantity_conflict": "conflict",
    "billing_not_due": "scheduled",
    "overdue_payment": "overdue",
    "none": "none",
}
_SITUATION_REC = {
    "not_billed_full": "bill", "not_billed_partial": "bill", "under_billed": "bill_rest", "conflict": "conflict", "scheduled": "scheduled",
    "duplicate": "duplicate", "partial_payment": "partial_payment", "overdue": "overdue", "billed": "billed",
    "waiting_delivery": "waiting_delivery", "none": "none",
}


def situation(f: dict[str, Any], exception_type: str | None = None) -> str:
    """Pick the template from validator facts first; fall back to the triage exception type."""
    ordered, delivered = f.get("order_qty"), f.get("delivered_qty")
    billed_qty = float(f.get("billed_qty") or 0)
    billable = f.get("billable") or {}
    if f.get("days_late") is not None and f.get("invoice_number") and exception_type == "overdue_payment":
        return "overdue"
    if len(f.get("duplicates") or []) > 1:
        return "duplicate"
    if any(c.get("field") == "delivered_qty" for c in f.get("conflicts") or []):
        return "conflict"
    if f.get("billed_by_us"):
        return "billed"
    if exception_type == "partial_payment" and f.get("paid_amount"):
        return "partial_payment"
    if delivered is None:
        if exception_type in ("duplicate_invoice", "partial_payment", "overdue_payment", "none", "quantity_conflict"):
            return _TYPE_SITUATION[exception_type]
        return "waiting_delivery" if ordered is not None else _TYPE_SITUATION.get(exception_type or "", "none")
    if billable.get("not_due"):
        return "scheduled"
    if billed_qty > 0 and float(billable.get("amount_when_due") or 0) > 0:
        return "under_billed"
    if billed_qty > 0:
        return "billed" if exception_type != "partial_payment" else "partial_payment"
    if float(billable.get("amount_when_due") or 0) <= 0 and exception_type in (None, "none"):
        return "none"
    if ordered is not None and float(delivered) >= float(ordered):
        return "not_billed_full"
    return "not_billed_partial"


def _conflict_values(f: dict[str, Any], lang: str) -> dict[str, str]:
    labels = SOURCE_LABEL[lang]
    c = next((c for c in f.get("conflicts") or [] if c.get("field") == "delivered_qty"), None)
    vals = list((c or {}).get("values", {}).items()) if isinstance((c or {}).get("values"), dict) else []
    if len(vals) < 2:
        vals = [("whatsapp", "?"), ("sheets", "?")]
    # challan/WhatsApp first, sheet second (how people talk about it)
    vals.sort(key=lambda kv: {"media": 0, "whatsapp": 1, "gmail": 2, "sheets": 3}.get(kv[0], 4))
    alias = f.get("source_alias") or {}
    vals = [(alias.get(k, k), v) for k, v in vals]
    vals.sort(key=lambda kv: {"media": 0, "whatsapp": 1, "gmail": 2, "sheets": 3}.get(kv[0], 4))
    (sa, va), (sb, vb) = vals[0], vals[1]
    la = labels.get(sa, sa)
    lb = labels.get(sb, sb)
    if lang == "en":
        lb = lb if lb.startswith("Your") else lb.lower() if lb in ("Sheet", "Email", "Challan") else lb
    return {"a_label": la, "a": qty(va), "b_label": lb, "b": qty(vb)}


def explain(f: dict[str, Any], lang: str | None = "en", exception_type: str | None = None) -> dict[str, str]:
    """Returns {situation, headline, recommendation}. `f` = validator facts json plus optional extras:
    customer, billed_qty, gst {taxable, tax_total, total}, invoice_number, invoice_total, days_late, amount, billed_by_us."""
    lang = _lang(lang)
    sit = situation(f, exception_type)
    billable = f.get("billable") or {}
    gst = f.get("gst") or {}
    taxable = gst.get("taxable", billable.get("amount_when_due", billable.get("amount", 0)) or 0)
    vals = {
        "date": short_date(billable.get("due_at") if sit == "scheduled" else f.get("delivered_at")),
        "delivered": qty(f.get("delivered_qty")), "ordered": qty(f.get("order_qty")), "item": f.get("item") or "items",
        "billed": qty(f.get("billed_qty") or 0), "po": f.get("po_ref") or "", "customer": f.get("customer") or f.get("customer_name") or "the customer",
        "invoices": ", ".join(d.get("invoice_number") or "?" for d in f.get("duplicates") or []),
        "paid": inr(f.get("paid_amount") or 0), "total": inr(gst.get("total", f.get("invoice_total") or taxable or 0)),
        "invoice": f.get("invoice_number") or "", "days": str(f.get("days_late") or 0), "amount": inr(f.get("amount") or taxable or 0),
        "qty": qty(billable.get("billable_qty")), "taxable": inr(taxable), "tax": inr(gst.get("tax_total", 0)),
        "balance": inr(max(0.0, float(f.get("invoice_total") or 0) - float(f.get("paid_amount") or 0))),
    }
    if sit == "conflict":
        vals.update(_conflict_values(f, lang))
    if sit == "partial_payment":
        vals["total"] = inr(f.get("invoice_total") or 0)
    if sit == "scheduled":
        vals["date"] = short_date(billable.get("due_at"))
    head = HEADLINES[lang][sit].format(**vals)
    rec = RECOMMENDATIONS[lang][_SITUATION_REC[sit]].format(**vals)
    return {"situation": sit, "headline": head, "recommendation": rec}


# ------------------------------------------------------------------ messages
REMINDER = {
    "en": {
        7: "Hello {customer}, a gentle reminder that invoice {invoice} for {amount} was due on {due}. You can pay here: {upi} . Please ignore if already paid. Thank you, {company}",
        15: "Hello {customer}, invoice {invoice} for {amount} is now {days} days past due. Kindly arrange the payment: {upi} . Thank you, {company}",
        30: "Dear {customer}, invoice {invoice} for {amount} is {days} days overdue. Please clear it this week to avoid a hold on further dispatches. Pay here: {upi} . {company}",
    },
    "hi": {
        7: "नमस्ते {customer}, याद दिला दें कि बिल {invoice} ({amount}) की तारीख {due} थी। यहाँ भुगतान करें: {upi} . अगर भुगतान हो चुका है तो इसे अनदेखा करें। धन्यवाद, {company}",
        15: "नमस्ते {customer}, बिल {invoice} ({amount}) {days} दिन से बकाया है। कृपया भुगतान करें: {upi} . धन्यवाद, {company}",
        30: "प्रिय {customer}, बिल {invoice} ({amount}) {days} दिन से बकाया है। आगे की डिलीवरी न रुके, इसलिए इस हफ़्ते भुगतान करें: {upi} . {company}",
    },
    "te": {
        7: "నమస్తే {customer}, బిల్లు {invoice} ({amount}) గడువు {due}న ముగిసింది. ఇక్కడ చెల్లించండి: {upi} . ఇప్పటికే చెల్లించి ఉంటే పట్టించుకోకండి. ధన్యవాదాలు, {company}",
        15: "నమస్తే {customer}, బిల్లు {invoice} ({amount}) {days} రోజులుగా బాకీ ఉంది. దయచేసి చెల్లించండి: {upi} . ధన్యవాదాలు, {company}",
        30: "ప్రియమైన {customer}, బిల్లు {invoice} ({amount}) {days} రోజులుగా బాకీ. తదుపరి డెలివరీలు ఆగకుండా ఈ వారం చెల్లించండి: {upi} . {company}",
    },
}


def reminder_text(stage: int, lang: str | None, **v: Any) -> str:
    lang = _lang(lang)
    key = 7 if stage <= 7 else (15 if stage <= 15 else 30)
    return REMINDER[lang][key].format(**v)


APPROVAL_PROMPT = {
    "en": "Approval needed: {what}\n{customer} · {po}\n{amount} + GST {gst} = {total}\nProof: {proofs}\nReply 1 to Approve, 2 to Reject, 3 for proof.",
    "hi": "मंज़ूरी चाहिए: {what}\n{customer} · {po}\n{amount} + GST {gst} = {total}\nसबूत: {proofs}\nमंज़ूर करने के लिए 1, मना करने के लिए 2, सबूत के लिए 3 भेजें।",
    "te": "ఆమోదం కావాలి: {what}\n{customer} · {po}\n{amount} + GST {gst} = {total}\nఆధారాలు: {proofs}\nఆమోదించడానికి 1, తిరస్కరించడానికి 2, ఆధారాల కోసం 3 పంపండి.",
}
APPROVAL_DONE = {
    "en": "Done. Invoice {invoice} created in Zoho and checked: {total}.",
    "hi": "हो गया। Zoho में बिल {invoice} बना और जाँचा गया: {total}।",
    "te": "పూర్తయింది. Zohoలో బిల్లు {invoice} వేసి సరిచూశాం: {total}.",
}
APPROVAL_EXPIRED = {
    "en": "This approval expired because the evidence changed. Here is the new one.",
    "hi": "सबूत बदल गया, इसलिए यह मंज़ूरी रद्द हो गई। नई मंज़ूरी यह है।",
    "te": "ఆధారాలు మారినందున ఈ ఆమోదం గడువు ముగిసింది. కొత్తది ఇదిగో.",
}
APPROVAL_ACK = {
    "en": {"approved": "Approved. We will create the invoice and check it in Zoho.", "partially_approved": "Approved. One more approver is needed.",
           "rejected": "Rejected. Nothing was billed."},
    "hi": {"approved": "मंज़ूर। हम बिल बनाकर Zoho में जाँचेंगे।", "partially_approved": "मंज़ूर। एक और व्यक्ति की मंज़ूरी चाहिए।", "rejected": "मना कर दिया। कोई बिल नहीं बना।"},
    "te": {"approved": "ఆమోదించారు. బిల్లు వేసి Zohoలో సరిచూస్తాం.", "partially_approved": "ఆమోదించారు. ఇంకొకరి ఆమోదం కావాలి.", "rejected": "తిరస్కరించారు. బిల్లు వేయలేదు."},
}
DIGEST = {
    "en": "Good morning. To bill: {bill_n} deliveries, {bill_amt}. To chase: {chase_n} invoices, {chase_amt}. Waiting for you: {wait_n} approvals.",
    "hi": "सुप्रभात। बिल बनाने हैं: {bill_n} डिलीवरी, {bill_amt}। वसूली: {chase_n} बिल, {chase_amt}। आपकी मंज़ूरी बाकी: {wait_n}।",
    "te": "శుభోదయం. బిల్లు వేయాల్సినవి: {bill_n} డెలివరీలు, {bill_amt}. వసూలు: {chase_n} బిల్లులు, {chase_amt}. మీ ఆమోదం కోసం: {wait_n}.",
}
RECEIPT = {
    "en": "Got it ✓ Added to {po} ({customer})",
    "hi": "मिल गया ✓ {po} ({customer}) में जोड़ा",
    "te": "అందింది ✓ {po} ({customer})కి జోడించాం",
}
WHICH_PO = {"en": "Which PO is this for?", "hi": "यह किस PO के लिए है?", "te": "ఇది ఏ PO కోసం?"}


def text(table: dict[str, Any], lang: str | None, **v: Any) -> str:
    return table[_lang(lang)].format(**v)
