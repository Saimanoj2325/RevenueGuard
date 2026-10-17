"""Plain-language templates (en/hi/te) per exception type, GST preview maths, Indian formatting, UPI links, WA tokens."""
import pytest

from app import plain_language as pl
from app.gst import gst_preview, indian_digits, inr, words_indian

BASE = {"po_ref": "PO-184", "customer": "Example Customer Pvt Ltd", "item": "Model X", "rate": 1000.0, "order_qty": 100.0}


def facts(**kw):
    f = dict(BASE)
    f.update(kw)
    return f


CASES = {
    # exception type -> (facts, expected situation, english headline, english recommendation fragment)
    "missing_invoice": (facts(delivered_qty=100.0, delivered_at="2026-10-09T06:00:00+00:00",
                              billable={"billable_qty": 100.0, "rate": 1000.0, "amount": 100000.0, "amount_when_due": 100000.0},
                              gst={"taxable": 100000, "tax_total": 18000, "total": 118000}),
                        "not_billed_full", "Delivered in full on 9 Oct. No invoice in Zoho.", "Bill ₹1,00,000 + GST ₹18,000 = ₹1,18,000"),
    "partial_delivery": (facts(delivered_qty=70.0, billable={"billable_qty": 70.0, "rate": 1000.0, "amount": 70000.0, "amount_when_due": 70000.0},
                               gst={"taxable": 70000, "tax_total": 12600, "total": 82600}),
                         "not_billed_partial", "Delivered 70 of 100 Model X. Nothing billed.", "Bill ₹70,000 + GST ₹12,600 = ₹82,600 to Example Customer Pvt Ltd for 70 × Model X."),
    "duplicate_invoice": (facts(delivered_qty=100.0, duplicates=[{"invoice_number": "INV-1"}, {"invoice_number": "INV-2"}]),
                          "duplicate", "Billed twice for PO-184: INV-1, INV-2.", "Do not bill again"),
    "partial_payment": (facts(delivered_qty=100.0, billed_qty=100.0, paid_amount=50000.0, invoice_total=118000.0, invoice_number="INV-2301",
                              billable={"billable_qty": 0.0, "amount": 0.0, "amount_when_due": 0.0}),
                        "partial_payment", "Paid ₹50,000 of ₹1,18,000 on INV-2301.", "balance ₹68,000"),
    "quantity_conflict": (facts(delivered_qty=25.0, conflicts=[{"field": "delivered_qty", "values": {"sheets": 25.0, "whatsapp": 30.0}}], source_alias={"whatsapp": "media"}),
                          "conflict", "Challan says 30, sheet says 25.", "Check the delivery count"),
    "billing_not_due": (facts(delivered_qty=96.0, billable={"billable_qty": 96.0, "amount": 0.0, "amount_when_due": 96000.0, "not_due": True, "due_at": "2026-10-16T03:30:00+00:00"}),
                        "scheduled", "Delivered. Terms say bill after 16 Oct.", "16 Oct"),
    "none": (facts(delivered_qty=None, order_qty=None), "none", "Nothing to do.", "Nothing to do."),
}


@pytest.mark.parametrize("exc", sorted(CASES))
def test_headline_and_recommendation_for_every_exception_type(exc):
    f, sit, head, rec = CASES[exc]
    out = pl.explain(f, "en", exc)
    assert out["situation"] == sit
    assert out["headline"] == head
    assert rec in out["recommendation"]
    for lang in ("hi", "te"):
        o = pl.explain(f, lang, exc)
        assert o["situation"] == sit
        assert o["headline"] and o["headline"] != head and o["recommendation"]
        # numbers are the validator's numbers in every language
        for tok in ("₹82,600", "₹1,18,000", "INV-2301"):
            if tok in head or tok in out["recommendation"]:
                assert tok in o["headline"] + o["recommendation"]


def test_overdue_and_under_billed_templates():
    o = pl.explain({"invoice_number": "INV-2190", "days_late": 41, "amount": 85000}, "en", "overdue_payment")
    assert o["headline"] == "INV-2190 is 41 days late: ₹85,000." and "UPI" in o["recommendation"]
    u = pl.explain(facts(order_qty=60.0, delivered_qty=55.0, billed_qty=40.0, billable={"billable_qty": 15.0, "rate": 2500.0, "amount": 37500.0, "amount_when_due": 37500.0},
                         gst={"taxable": 37500, "tax_total": 6750, "total": 44250}), "en", "partial_delivery")
    assert u["headline"] == "Delivered 55, billed only 40." and "missing 15 units" in u["recommendation"]
    assert pl.explain(facts(delivered_qty=70.0), "te", "partial_delivery")["headline"] == "Model X 100లో 70 చేరాయి. ఇంకా బిల్లు వేయలేదు."
    assert pl.explain(facts(delivered_qty=70.0), "hi", "partial_delivery")["headline"] == "Model X के 100 में से 70 पहुँचे। कोई बिल नहीं बना।"


def test_message_templates_three_languages():
    for lang in ("en", "hi", "te"):
        for stage in (7, 15, 30):
            t = pl.reminder_text(stage, lang, customer="Example", invoice="INV-2190", amount="₹85,000", due="4 Sep", days=41, upi="upi://pay?pa=x@y", company="Demo")
            assert "INV-2190" in t and "upi://pay" in t and "₹85,000" in t
        assert "{" not in pl.text(pl.DIGEST, lang, bill_n=6, bill_amt="₹5", chase_n=4, chase_amt="₹2", wait_n=3)
        assert "1" in pl.text(pl.APPROVAL_PROMPT, lang, what="Invoice", customer="C", po="PO-1", amount="₹1", gst="₹0", total="₹1", proofs="PO")
    assert pl.reminder_text(7, "en", customer="A", invoice="I", amount="₹1", due="d", days=1, upi="u", company="c").startswith("Hello A, a gentle reminder")
    assert "hold on further dispatches" in pl.reminder_text(30, "en", customer="A", invoice="I", amount="₹1", due="d", days=31, upi="u", company="c")


def test_indian_formatting_and_words():
    assert indian_digits(482000) == "4,82,000" and indian_digits(12345678) == "1,23,45,678" and indian_digits(999) == "999"
    assert inr(82600) == "₹82,600" and indian_digits(1000.5) == "1,000.50"
    assert words_indian(82600) == "Rupees Eighty Two Thousand Six Hundred Only"
    assert words_indian(236000) == "Rupees Two Lakh Thirty Six Thousand Only"
    assert words_indian(12500000) == "Rupees One Crore Twenty Five Lakh Only"
    assert words_indian(101.5) == "Rupees One Hundred One and Fifty Paise Only"


SETTINGS = {"company": {"gstin": "36AAACD1234A1Z9", "state_code": "36"}, "gst_default_rate": 18, "items": {"Model X": {"hsn": "8504", "rate": 18}, "Bolt": {"hsn": "7318", "rate": 12}},
            "einvoice_turnover_threshold": 50_000_000, "annual_turnover": 60_000_000}


def test_gst_same_state_cgst_sgst():
    g = gst_preview([{"item": "Model X", "qty": 70, "rate": 1000}], SETTINGS, "36AABCE1234F1Z5")
    assert (g["taxable"], g["cgst"], g["sgst"], g["igst"], g["round_off"], g["total"]) == (70000, 6300, 6300, 0, 0, 82600)
    assert g["place_of_supply"] == "36-Telangana" and g["lines"][0]["hsn"] == "8504" and g["total_words"].startswith("Rupees Eighty Two Thousand")
    assert g["irn_note"] and "IRN" in g["irn_note"]


def test_gst_other_state_igst_round_off_and_item_rate():
    g = gst_preview([{"item": "Model X", "qty": 3, "rate": 333.33}, {"item": "Bolt", "qty": 7, "rate": 11.11}], SETTINGS, "29AAGFO5678K1Z2")
    assert g["cgst"] == 0 and g["sgst"] == 0 and g["igst"] == round(999.99 * 0.18 + 77.77 * 0.12, 2)
    exact = 999.99 + 77.77 + g["igst"]
    assert g["total"] == round(exact) and abs(g["round_off"] - (g["total"] - exact)) < 0.01
    assert g["lines"][1]["gst_rate"] == 12
    no_irn = gst_preview([{"item": "X", "qty": 1, "rate": 100}], {**SETTINGS, "annual_turnover": 1_000_000}, "29AAGFO5678K1Z2")
    assert no_irn["irn_note"] is None and no_irn["rate"] == 18


def test_upi_link_and_wa_token():
    from app.notify import approval_token, verify_approval_token
    from app.reminders import upi_link

    assert upi_link("demomfg@okhdfcbank", "Demo Manufacturing Pvt Ltd", 85000, "INV-2190") == \
        "upi://pay?pa=demomfg@okhdfcbank&pn=Demo%20Manufacturing%20Pvt%20Ltd&am=85000&tn=INV-2190"
    tok, exp = approval_token("ap1", "hash1", "+91 98480 12345", ttl=60)
    assert verify_approval_token(tok, "ap1", "hash1", "919848012345") is None
    assert verify_approval_token(tok, "ap1", "hash2", "919848012345")  # payload changed
    assert verify_approval_token(tok, "ap1", "hash1", "919999999999")  # other phone
    assert verify_approval_token(tok, "ap1", "hash1", "919848012345", now=exp + 1) == "token expired"
