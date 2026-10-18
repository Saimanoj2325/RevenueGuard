"""UX v2 business endpoints (docs/CONTRACT_V2.md) against the real models, DEMO_MODE showcase data and the same
approval / gateway path."""
import json

import pytest
from httpx import ASGITransport, AsyncClient

from .helpers import case_by_ref, latest_approval, play, suppress, user

TOBILL_KEYS = {"case_ref", "customer_id", "customer", "po_ref", "headline", "status", "waiting_days", "amount", "proofs"}
CHASE_KEYS = {"invoice_number", "customer_id", "customer", "amount", "due_date", "days_late", "reminder", "snoozed_until"}
CARD_KEYS = {"id", "case_ref", "customer", "po_ref", "what", "amount", "gst", "total", "approvers_needed", "approvals", "proofs", "expires_reason", "kind"}


class Api:
    def __init__(self, c):
        self.c = c
        self.tok = {}

    async def h(self, who="admin"):
        if who not in self.tok:
            r = await self.c.post("/auth/login", json={"email": f"{who}@demo.in", "password": "demo1234"})
            self.tok[who] = r.json()["token"]
        return {"Authorization": f"Bearer {self.tok[who]}"}

    async def get(self, path, who="admin", **kw):
        return await self.c.get(path, headers=await self.h(who), **kw)

    async def post(self, path, body=None, who="admin"):
        return await self.c.post(path, json=body if body is not None else {}, headers=await self.h(who))

    async def put(self, path, body, who="admin"):
        return await self.c.put(path, json=body, headers=await self.h(who))


@pytest.fixture
async def api(db):
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t", timeout=300) as c:
        yield Api(c)


async def test_showcase_every_screen_returns_the_story(api):
    r = await api.c.post("/demo/showcase")
    assert r.status_code == 200 and r.json()["po_185"] == "AWAITING_APPROVAL"

    d = (await api.get("/dashboard/summary?period=month")).json()
    assert set(d) >= {"not_billed", "overdue", "recovered", "waiting", "flow", "to_bill", "to_chase", "approvals"}
    assert d["overdue"] == {"amount": 215500, "count": 4, "reminders_sent": 2}
    assert d["recovered"] == {"amount": 340000, "invoices": 5, "last_month": 185000}
    assert d["not_billed"]["count"] >= 6 and set(d["flow"]) == {"ordered", "delivered", "billed", "paid"}
    assert all(TOBILL_KEYS <= set(r) for r in d["to_bill"]) and all(CHASE_KEYS <= set(r) for r in d["to_chase"])
    assert all(CARD_KEYS <= set(c) for c in d["approvals"])

    bill = (await api.get("/bill")).json()
    rows = {r["po_ref"]: r for r in bill["items"]}
    assert rows["PO-184"]["headline"] == "Delivered 70 of 100 Model X. Nothing billed." and rows["PO-184"]["amount"] == 70000
    assert {p["label"] for p in rows["PO-184"]["proofs"]} >= {"PO", "Challan", "Voice note", "Sheet"}
    assert rows["PO-185"]["amount"] == 200000 and rows["PO-176"]["status"] == "partial" and rows["PO-176"]["amount"] == 37500
    assert rows["PO-188"]["status"] == "needs_check" and rows["PO-188"]["headline"] == "Challan says 30, sheet says 25."
    assert rows["PO-193"]["status"] == "scheduled" and "PO-190" not in rows
    assert bill["total_amount"] == sum(r["amount"] for r in bill["items"])
    nb = (await api.get("/bill?status=not_billable")).json()["items"]
    assert [r["po_ref"] for r in nb] == ["PO-190"]
    assert [r["po_ref"] for r in (await api.get("/bill?q=kaveri")).json()["items"]] == ["PO-176"]
    hi = (await api.get("/bill?lang=hi")).json()["items"]
    assert any("पहुँचे" in r["headline"] for r in hi)

    col = (await api.get("/collect")).json()
    assert col["total_amount"] == 215500 and [r["invoice_number"] for r in col["items"]][:2] == ["INV-2185", "INV-2190"]
    assert [r["invoice_number"] for r in (await api.get("/collect?bucket=60%2B")).json()["items"]] == ["INV-2185"]
    assert [r["invoice_number"] for r in (await api.get("/collect?bucket=0-7")).json()["items"]] == []

    s = (await api.get("/cases/RG-1042/summary")).json()
    assert s["headline"] == "Delivered 70 of 100 Model X. Nothing billed."
    assert s["recommendation"] == "Bill ₹70,000 + GST ₹12,600 = ₹82,600 to Example Customer Pvt Ltd for 70 × Model X."
    assert s["confidence"] == "high" and s["journey"]["current"] == "waiting"
    assert [x["key"] for x in s["journey"]["steps"]] == ["received", "read", "matched", "checked", "waiting", "invoiced", "verified", "paid"]
    assert {x["stage"]: x["status"] for x in s["documents"]} == {"order": "found", "delivery": "partial", "invoice": "missing", "payment": "missing"}
    delivered = next(f for f in s["facts"] if f["id"] == "delivered_qty")
    assert delivered["value"] == "70" and delivered["changed_from"] == "60"
    kinds = {c["kind"] for c in s["callouts"]}
    assert {"approval_expired", "quarantined", "corrected"} <= kinds
    assert any("₹60,000 approval expired" in c["text"] and "60 to 70" in c["text"] for c in s["callouts"])
    pv = s["invoice_preview"]
    assert (pv["taxable"], pv["cgst"], pv["sgst"], pv["igst"], pv["total"]) == (70000, 6300, 6300, 0, 82600)
    assert pv["total_words"] == "Rupees Eighty Two Thousand Six Hundred Only" and pv["seller_gstin"] and pv["buyer_gstin"] == "36AABCE1234F1Z5"
    assert s["approval"]["total"] == 82600 and s["approval"]["approvers_needed"] == 1
    assert s["how_found"]["agents"] >= 3 and s["how_found"]["extra_searches"]
    te = (await api.get("/cases/RG-1042/summary?lang=te")).json()
    assert te["headline"] == "Model X 100లో 70 చేరాయి. ఇంకా బిల్లు వేయలేదు."
    s185 = (await api.get("/cases/RG-1043/summary")).json()
    assert s185["approval"]["approvers_needed"] == 2 and s185["invoice_preview"]["igst"] == 36000 and s185["invoice_preview"]["total"] == 236000

    aps = (await api.get("/approvals?status=pending")).json()
    assert aps["items"] == aps["approvals"] and all("card" in a for a in aps["items"])
    kinds = {a["card"]["kind"] for a in aps["items"]}
    assert kinds == {"invoice", "reminder"}
    rem = next(a["card"] for a in aps["items"] if a["card"]["kind"] == "reminder")
    assert rem["what"].startswith("WhatsApp reminder · INV-2190")
    # the hash binds the GST lines: PO-184's approved payload carries them
    p184 = next(a for a in aps["items"] if a["case"]["po_ref"] == "PO-184")
    from app.security import payload_hash

    assert p184["proposal"]["action"]["gst"]["total"] == 82600 and payload_hash(p184["proposal"]["action"]) == p184["payload_hash"]

    custs = (await api.get("/customers")).json()["items"]
    assert len(custs) >= 8
    by = {c["name"]: c for c in custs}
    assert by["Godavari Plastics"]["risk"] == "high" and "60 days" in by["Godavari Plastics"]["risk_reason"]
    assert by["Example Customer Pvt Ltd"]["overdue"] == 85000 and by["Nizam Electricals"]["risk"] == "good"
    cd = (await api.get("/customers/zc-1001")).json()
    assert cd["customer"]["gstin"] == "36AABCE1234F1Z5" and "•" in cd["customer"]["contact_masked"]
    assert set(cd["stats"]) >= {"not_billed", "overdue", "avg_days_to_pay", "terms_days", "risk", "risk_reason"}
    po184 = next(o for o in cd["orders"] if o["po_ref"] == "PO-184")
    assert (po184["ordered"], po184["delivered"], po184["billed"], po184["case_ref"]) == (100000, 70000, 0, "RG-1042")
    assert any(f["kind"] == "reminder" for f in cd["followups"])
    assert (await api.get("/customers/nope")).status_code == 404

    un = (await api.get("/unlinked")).json()["items"]
    assert len(un) == 3
    ravi = next(i for i in un if "184" in i["preview"])
    assert ravi["suggestions"][0]["case_ref"] == "RG-1042" and ravi["extracted"]["customer"] == "Exmpl Cust"

    rep = (await api.get("/reports/summary")).json()
    assert set(rep) >= {"recovered_by_month", "unbilled_ageing", "collections"} and set(rep["unbilled_ageing"]) == {"0-7", "8-30", "31-60", "60+"}
    assert rep["recovered_by_month"][-1]["amount"] == 340000 and rep["collections"]["billed"] > 0
    csv = await api.get("/reports/export?format=csv")
    assert csv.status_code == 200 and csv.headers["content-type"].startswith("text/csv")
    head = csv.text.splitlines()[0]
    assert "CGST" in head and "SGST" in head and "IGST" in head and "Customer GSTIN" in head
    assert "INV-2205" in csv.text

    conns = (await api.get("/connectors")).json()["connectors"]
    assert all({"health", "last_sync", "error_plain"} <= set(c) for c in conns) and {c["health"] for c in conns} == {"ok"}

    ask = (await api.post("/ask", {"question": "receivables over 50,000"})).json()
    assert ask["table"]["columns"] == ["Customer", "Invoice", "Amount", "Days late"] and ask["proofs"] and ask["actions"]
    assert all(row[2] > 50000 for row in ask["table"]["rows"])
    why = (await api.post("/ask", {"question": "why wasn't PO-184 billed?"})).json()
    assert why["answer"].startswith("Delivered 70 of 100 Model X") and why["actions"][0]["href"] == "/case?id=RG-1042"
    unb = (await api.post("/ask", {"question": "what is unbilled?"})).json()
    assert unb["intent"] == "unbilled" and "₹" in unb["answer"]
    cust = (await api.post("/ask", {"question": "how is Godavari doing"})).json()
    assert cust["intent"] == "customer" and "Godavari Plastics" in cust["answer"]
    od = (await api.post("/ask", {"question": "overdue more than 1 lakh"})).json()
    assert od["intent"] == "receivables" and od["table"] is None
    refuse = (await api.post("/ask", {"question": "approve the PO-184 invoice"})).json()
    assert refuse["intent"] == "refused_write" and refuse["table"] is None
    assert (await api.post("/ask", {"question": "mark INV-2190 as paid"})).json()["intent"] == "refused_write"
    assert (await api.post("/ask", {"question": "कितना बकाया है?", "lang": "hi"})).json()["answer"]

    al = (await api.get("/aliases")).json()
    assert al == {"items": []} or isinstance(al["items"], list)


async def test_unlinked_link_learns_aliases_used_in_matching(api, db):
    from app.demo.scenes import reset_demo
    from app.intake import IntakeItem, intake

    await reset_demo()
    await play(1)  # opens RG-1042 for PO-184
    items = (await api.get("/unlinked")).json()["items"]
    ravi = next(i for i in items if "184" in i["preview"])
    assert (await api.post(f"/unlinked/{ravi['id']}/link", {"case_ref": "RG-1042"}, who="viewer")).status_code == 403
    async with suppress():
        r = await api.post(f"/unlinked/{ravi['id']}/link", {"case_ref": "RG-1042"}, who="ops")
    assert r.status_code == 200, r.text
    learned = {(a["kind"], a["alias"], a["canonical"]) for a in r.json()["aliases"]}
    assert ("po", "184", "PO-184") in learned and ("customer", "Exmpl Cust", "Example Customer Pvt Ltd") in learned
    assert (await api.post(f"/unlinked/{ravi['id']}/link", {"case_ref": "RG-1042"}, who="ops")).status_code == 409
    al = {(a["kind"], a["alias"]) for a in (await api.get("/aliases")).json()["items"]}
    assert {("po", "184"), ("customer", "Exmpl Cust")} <= al
    assert ravi["id"] not in {i["id"] for i in (await api.get("/unlinked")).json()["items"]}
    case = await case_by_ref("PO-184")
    detail = (await api.get(f"/cases/{case.case_number}")).json()
    assert any(n["source_id"] == "seed-unlinked-1" for n in detail["evidence"]["nodes"])
    # the learned aliases now match a new message with no "PO" in it
    res = await intake(db, IntakeItem(source="whatsapp", source_id="wa-alias-1", sender_name="Ravi", chat_id="9199@s.whatsapp.net",
                                      text="Exmpl Cust: 5 boxes delivered for 184 today"), enqueue=False)
    assert res["status"] == "accepted" and res["case_number"] == "RG-1042" and res["aliases_used"]
    other = next(i for i in (await api.get("/unlinked")).json()["items"] if "Payment" in i["preview"])
    assert (await api.post(f"/unlinked/{other['id']}/ignore", who="ops")).json() == {"ok": True}


async def test_not_billable_snooze_and_roles(api, db):
    from app.demo.business_seed import seed_business

    await seed_business(db)
    assert (await api.post("/bill/RG-1031/not-billable", {"reason": "sample", "note": "free sample"}, who="viewer")).status_code == 403
    assert (await api.post("/bill/RG-1031/not-billable", {"reason": "bogus"}, who="ops")).status_code == 422
    assert (await api.post("/bill/RG-1031/not-billable", {"reason": "sample", "note": "free sample"}, who="ops")).json() == {"ok": True}
    assert "PO-201" not in {r["po_ref"] for r in (await api.get("/bill")).json()["items"]}
    audit = (await api.get("/audit?case_id=RG-1031")).json()["entries"]
    assert any(e["event"] == "bill.not_billable" and e["data"]["reason"] == "sample" for e in audit)

    assert (await api.post("/collect/INV-2203/snooze", {"days": 7, "reason": "promised Friday"}, who="viewer")).status_code == 403
    r = (await api.post("/collect/INV-2203/snooze", {"days": 7, "reason": "promised Friday"}, who="ops")).json()
    assert r["ok"] and r["snoozed_until"]
    row = next(x for x in (await api.get("/collect")).json()["items"] if x["invoice_number"] == "INV-2203")
    assert row["snoozed_until"] == r["snoozed_until"]
    assert (await api.post("/collect/INV-9999/snooze", {"days": 3}, who="ops")).status_code == 404
    # admin-only settings / chats
    assert (await api.put("/settings", {"language": "hi"}, who="ops")).status_code == 403
    assert (await api.put("/connectors/whatsapp/chats", {"watched": []}, who="finance")).status_code == 403


async def test_reminder_draft_goes_through_approval_and_gateway(api, db):
    from app.connectors.registry import get_connector
    from app.db import session_scope
    from app.demo.business_seed import seed_business
    from app.models import Reminder
    from app.orchestrator.engine import drive_case

    await seed_business(db)
    assert (await api.post("/collect/INV-2177/draft-reminder", {"stage": 15}, who="viewer")).status_code == 403
    card = (await api.post("/collect/INV-2177/draft-reminder", {"stage": 15}, who="ops")).json()
    assert CARD_KEYS <= set(card) and card["kind"] == "reminder" and card["total"] == 62500
    assert card["upi_link"] == "upi://pay?pa=demomfg@okhdfcbank&pn=Demo%20Manufacturing%20Pvt%20Ltd&am=62500&tn=INV-2177"
    assert "upi://pay?pa=demomfg@okhdfcbank" in card["message"] and "INV-2177" in card["message"]
    async with session_scope() as s:
        wa = await get_connector(s, db, "whatsapp")
        assert not (wa.config.get("mock") or {}).get("sent")  # nothing sent before approval
    row = next(x for x in (await api.get("/collect")).json()["items"] if x["invoice_number"] == "INV-2177")
    assert row["reminder"] == {"stage": 15, "status": "draft"}
    assert (await api.post(f"/approvals/{card['id']}/approve", {"comment": "ok"}, who="ops")).status_code == 403
    async with suppress():
        ok = await api.post(f"/approvals/{card['id']}/approve", {"comment": "send"}, who="finance")
    assert ok.status_code == 200 and ok.json()["status"] == "approved"
    case = (await api.get(f"/cases/{card['case_ref']}")).json()["case"]
    assert await drive_case(case["id"]) == "CLOSED"
    async with session_scope() as s:
        wa = await get_connector(s, db, "whatsapp")
        sent = wa.config["mock"]["sent"]
        assert len(sent) == 1 and "upi://pay" in sent[0]["text"] and sent[0]["approval_id"] == card["id"]
        rem = [r for r in (await s.execute(__import__("sqlalchemy").select(Reminder).where(Reminder.approval_id == card["id"]))).scalars()]
        assert rem[0].status == "sent"
    # a second draft for the same invoice replaces nothing already sent and needs its own approval
    card2 = (await api.post("/collect/INV-2177/draft-reminder", {}, who="ops")).json()
    assert card2["id"] != card["id"] and card2["case_ref"] != card["case_ref"]
    assert (await api.post("/collect/INV-2150/draft-reminder", {}, who="ops")).status_code == 409  # already paid


async def test_fact_correction_new_version_expires_approval_and_revalidates(api, db):
    from app.orchestrator.engine import drive_case

    await play(7)  # PO-184 awaiting ₹60,000
    case = await case_by_ref()
    old = await latest_approval(case.id)
    assert (await api.post(f"/cases/{case.case_number}/facts/delivered_qty/correct", {"value": "70"}, who="viewer")).status_code == 403
    assert (await api.post(f"/cases/{case.case_number}/facts/amount/correct", {"value": "1"}, who="ops")).status_code == 422
    assert (await api.post(f"/cases/{case.case_number}/facts/delivered_qty/correct", {"value": "lots"}, who="ops")).status_code == 422
    async with suppress():
        r = await api.post(f"/cases/{case.case_number}/facts/delivered_qty/correct", {"value": "70", "note": "Suresh confirmed 70 on call"}, who="ops")
    assert r.status_code == 200 and r.json()["evidence_version"] == case.evidence_version + 1
    from app.db import session_scope
    from app.models import Approval

    async with session_scope() as s:
        assert (await s.get(Approval, old.id)).status == "expired"
    assert await drive_case(case.id) == "AWAITING_APPROVAL"
    new = await latest_approval(case.id)
    assert new.id != old.id and float(new.amount) == 70000.0
    summ = (await api.get(f"/cases/{case.case_number}/summary")).json()
    d = next(f for f in summ["facts"] if f["id"] == "delivered_qty")
    assert d["value"] == "70" and d["changed_from"] == "60" and d["source"]["kind"] == "manual"
    assert any(c["kind"] == "corrected" for c in summ["callouts"])
    audit = (await api.get(f"/audit?case_id={case.case_number}")).json()["entries"]
    assert any(e["event"] == "fact.corrected" and e["data"]["old"] == "60.0" and e["data"]["new"] == "70.0" for e in audit)


async def test_bulk_approve_reuses_single_approve_rules(api, db):
    from app.demo.scenes import _tenant_and_users, beat_9

    await play(7)
    tid, users = await _tenant_and_users()
    async with suppress():
        await beat_9(tid, users)  # PO-185 ₹2,00,000 -> two approvers
    a184 = await latest_approval((await case_by_ref("PO-184")).id)
    a185 = await latest_approval((await case_by_ref("PO-185")).id)
    assert a185.required_approvers == 2
    assert (await api.post("/approvals/bulk-approve", {"ids": [a184.id, a185.id]}, who="ops")).status_code == 403
    async with suppress():
        r = (await api.post("/approvals/bulk-approve", {"ids": [a184.id, a185.id, "nope"]}, who="finance")).json()["results"]
    assert r[0] == {"id": a184.id, "ok": True, "detail": "approved"}
    assert r[1] == {"id": a185.id, "ok": True, "detail": "partially_approved"}
    assert r[2]["ok"] is False and "not found" in r[2]["detail"]
    async with suppress():
        again = (await api.post("/approvals/bulk-approve", {"ids": [a185.id]}, who="finance")).json()["results"][0]
        second = (await api.post("/approvals/bulk-approve", {"ids": [a185.id]}, who="finance2")).json()["results"][0]
    assert again["ok"] is False and "different person" in again["detail"]
    assert second == {"id": a185.id, "ok": True, "detail": "approved"}


async def test_settings_team_notifications_phone(api, db):
    s = (await api.get("/settings", who="viewer")).json()
    assert s["company"]["gstin"] and s["reminder_ladder"] == [7, 15, 30] and s["gst_default_rate"] == 18 and s["digest"]["time"] == "09:00"
    assert (await api.put("/settings", {"company": {"gstin": "bad"}})).status_code == 422
    assert (await api.put("/settings", {"company": {"upi_vpa": "no-at-sign"}})).status_code == 422
    out = (await api.put("/settings", {"company": {"gstin": "29AAACD1234A1Z9", "upi_vpa": "acme@okaxis"}, "digest": {"time": "08:30"}, "reminder_ladder": [30, 7, 15, 7]})).json()
    assert out["company"]["state_code"] == "29" and out["company"]["upi_vpa"] == "acme@okaxis" and out["digest"]["time"] == "08:30" and out["digest"]["enabled"] is True
    assert out["reminder_ladder"] == [7, 15, 30] and out["company"]["name"]
    assert (await api.put("/me/phone", {"phone": "12"}, who="finance")).status_code == 422
    ph = (await api.put("/me/phone", {"phone": "+91 98480 12345"}, who="finance")).json()
    assert ph["phone_masked"] == "+91 98••••••45" and ph["can_approve_on_whatsapp"] is True
    team = {u["email"]: u for u in (await api.get("/settings/team")).json()["items"]}
    assert team["finance@demo.in"]["phone_masked"] == "+91 98••••••45" and team["ops@demo.in"]["phone_masked"] is None and team["ops@demo.in"]["role"] == "operator"
    n = (await api.put("/settings/notifications", {"digest": True, "channels": ["whatsapp", "email"], "quiet_hours": {"from": "21:00", "to": "07:30"}}, who="finance")).json()
    assert n["digest"] is True and n["approvals"] is True and n["quiet_hours"] == {"from": "21:00", "to": "07:30"}
    assert (await api.get("/settings/notifications", who="finance")).json()["channels"] == ["whatsapp", "email"]
    assert (await api.put("/me/phone", {"phone": ""}, who="finance")).json()["phone_masked"] is None


async def _wa_sent(tid, kind=None):
    from app.connectors.registry import get_connector
    from app.db import session_scope

    async with session_scope() as s:
        c = await get_connector(s, tid, "whatsapp")
        return [m for m in (c.config.get("mock") or {}).get("internal_sent", []) if kind is None or m["kind"] == kind]


async def _reply(api, body):
    from app.security import sign_headers

    raw = json.dumps(body).encode()
    return await api.c.post("/internal/wa-approval-reply", content=raw, headers=sign_headers(raw))


async def test_whatsapp_approval_prompt_reply_and_done(api, db):
    from app.notify import approval_token
    from app.orchestrator.engine import drive_case

    await api.put("/me/phone", {"phone": "9848012345"}, who="finance")
    await api.put("/me/phone", {"phone": "9848099999"}, who="ops")
    await play(7)  # approval created -> prompt to the linked approver phone (not the operator)
    prompts = await _wa_sent(db, "approval_prompt")
    case = await case_by_ref()
    ap = await latest_approval(case.id)
    assert len(prompts) == 1 and prompts[0]["to"] == "919848012345" and prompts[0]["approval_id"] == ap.id
    assert "Reply 1 to Approve, 2 to Reject, 3 for proof" in prompts[0]["text"] and "₹60,000 + GST ₹10,800 = ₹70,800" in prompts[0]["text"]
    tok, _ = approval_token(ap.id, ap.payload_hash, "919848012345")
    # unsigned / bad token / not an approver
    assert (await api.c.post("/internal/wa-approval-reply", json={"phone": "+919848012345", "approval_id": ap.id, "choice": "1", "token": tok})).status_code == 401
    assert (await _reply(api, {"phone": "+919848012345", "approval_id": ap.id, "choice": "1", "token": tok[:-2] + "00"})).status_code == 401
    ops_tok, _ = approval_token(ap.id, ap.payload_hash, "919848099999")
    assert (await _reply(api, {"phone": "+919848099999", "approval_id": ap.id, "choice": "1", "token": ops_tok})).status_code == 403
    proof = await _reply(api, {"phone": "+919848012345", "approval_id": ap.id, "choice": "3", "token": tok})
    assert proof.status_code == 200 and "Challan" in proof.json()["reply"]
    async with suppress():
        ok = await _reply(api, {"phone": "+919848012345", "approval_id": ap.id, "choice": "1", "token": tok})
    assert ok.status_code == 200 and ok.json()["status"] == "approved" and ok.json()["reply"].startswith("Approved")
    assert await drive_case(case.id) == "CLOSED"
    done = await _wa_sent(db, "approval_done")
    assert done and done[-1]["text"] == "Done. Invoice INV-2301 created in Zoho and checked: ₹70,800."


async def test_whatsapp_reply_to_expired_approval_sends_new_prompt(api, db):
    from app.notify import approval_token

    await api.put("/me/phone", {"phone": "9848012345"}, who="finance")
    await play(7)
    case = await case_by_ref()
    old = await latest_approval(case.id)
    tok, _ = approval_token(old.id, old.payload_hash, "919848012345")
    await play(10)  # correction 60 -> 70: old approval expires, a new ₹70,000 approval is created
    r = await _reply(api, {"phone": "+919848012345", "approval_id": old.id, "choice": "1", "token": tok})
    assert r.status_code == 409 and r.json()["reply"].startswith("This approval expired because the evidence changed")
    new = await latest_approval(case.id)
    assert r.json()["new_approval_id"] == new.id
    assert (await _wa_sent(db, "approval_prompt"))[-1]["approval_id"] == new.id


async def test_daily_digest_opt_in_and_audit(api, db):
    from app.demo.business_seed import seed_business
    from app.notify import run_digest

    await seed_business(db)
    await api.put("/me/phone", {"phone": "9848012345"}, who="finance")
    assert (await run_digest(db, force=True))["sent"] == 0  # nobody opted in yet
    await api.put("/settings/notifications", {"digest": True}, who="finance")
    await api.put("/settings", {"digest": {"time": "00:00"}})
    out = await run_digest(db)
    assert out["sent"] == 1 and out["text"].startswith("Good morning. To bill:")
    assert (await run_digest(db))["skipped"] == "already sent today"
    await api.put("/settings", {"digest": {"enabled": False}})
    assert (await _wa_sent(db, "digest"))[-1]["to"] == "919848012345"
    audit = (await api.get("/audit")).json()["entries"]
    assert any(e["event"] == "digest.sent" and e["data"]["recipients"] == 1 for e in audit)


async def test_whatsapp_chat_picker_mock_and_bridge_proxy(api, db, monkeypatch):
    from app.connectors.registry import get_connector
    from app.db import session_scope
    from app.routers import connectors as cr

    chats = (await api.get("/connectors/whatsapp/chats")).json()["items"]
    assert {"jid", "name", "is_group", "last_message_at", "watched"} <= set(chats[0])
    fam = next(c for c in chats if c["name"] == "Family")
    assert fam["watched"] is False
    r = await api.put("/connectors/whatsapp/chats", {"watched": ["120363000000000001@g.us"]})
    assert r.json() == {"ok": True, "watched": ["120363000000000001@g.us"]}
    w = {c["jid"]: c["watched"] for c in (await api.get("/connectors/whatsapp/chats")).json()["items"]}
    assert w["120363000000000001@g.us"] is True and w["919800000001@s.whatsapp.net"] is False
    # live mode: proxied to wa-bridge GET /chats + /allowlist and PUT /allowlist
    calls = []

    async def fake_bridge(method, path, payload=None):
        calls.append((method, path, payload))
        if path.startswith("/chats"):
            return [{"jid": "a@g.us", "name": "Ops", "is_group": True, "last_message_at": 1760000000}]
        if path == "/allowlist" and method == "GET":
            return {"jids": ["a@g.us"]}
        return {"ok": True, "jids": payload["jids"]}

    monkeypatch.setattr(cr, "_bridge", fake_bridge)
    async with session_scope() as s:
        (await get_connector(s, db, "whatsapp")).mode = "live"
    live = (await api.get("/connectors/whatsapp/chats")).json()
    assert live["mode"] == "live" and live["items"][0]["watched"] is True and live["items"][0]["last_message_at"].startswith("2025-10-09")
    assert (await api.put("/connectors/whatsapp/chats", {"watched": ["b@g.us"]})).json()["watched"] == ["b@g.us"]
    assert ("PUT", "/allowlist", {"jids": ["b@g.us"]}) in calls
    # kinds, numbers and names come through; the raw JID is never used as a name
    async def fake_bridge2(method, path, payload=None):
        if path.startswith("/chats"):
            return [
                {"jid": "1@g.us", "name": "Traders", "is_group": True, "kind": "community", "members": 240, "last_message_at": 1760000300},
                {"jid": "9@newsletter", "name": "GST Updates", "is_group": False, "last_message_at": 1760000200},
                {"jid": "81234@lid", "name": None, "is_group": False, "kind": "person", "phone": "919876543204", "last_message_at": 1760000100},
                {"jid": "status@broadcast", "name": "Status", "is_group": False, "last_message_at": 1760000050},
                {"jid": "919834149243@s.whatsapp.net", "name": "Mom", "is_group": False, "kind": "person", "phone": "919834149243",
                 "aliases": ["555@lid"], "last_message_at": 1760000040},
            ]
        return {"jids": ["555@lid"]}

    monkeypatch.setattr(cr, "_bridge", fake_bridge2)
    items = {c["jid"]: c for c in (await api.get("/connectors/whatsapp/chats")).json()["items"]}
    assert items["1@g.us"]["kind"] == "community" and items["1@g.us"]["members"] == 240 and items["1@g.us"]["is_group"] is True
    assert items["9@newsletter"]["kind"] == "channel" and items["9@newsletter"]["is_group"] is False
    assert items["81234@lid"]["name"] is None and items["81234@lid"]["phone"] == "919876543204"
    assert "status@broadcast" not in items
    assert items["919834149243@s.whatsapp.net"]["watched"] is True

    # stored status drifted: bridge says it's paired -> connector flips to connected; bridge says QR -> no stale chats
    from app.connectors import whatsapp as wa_mod

    async def st_open(self):
        return {"state": "open"}

    async def st_qr(self):
        return {"state": "qr"}

    monkeypatch.setattr(wa_mod.BridgeWhatsApp, "status", st_open)
    conns = {c["name"]: c for c in (await api.get("/connectors")).json()["items"]}
    assert conns["whatsapp"]["status"] == "connected"
    monkeypatch.setattr(wa_mod.BridgeWhatsApp, "status", st_qr)
    r = (await api.get("/connectors/whatsapp/chats")).json()
    assert r["items"] == [] and r["state"] == "qr"
    conns = {c["name"]: c for c in (await api.get("/connectors")).json()["items"]}
    assert conns["whatsapp"]["status"] == "disconnected"


async def test_sheet_mapping_proposal_and_read_delivery(api, db):
    import copy

    from app.connectors.registry import adapter, get_connector
    from app.db import session_scope
    from app.sheet_mapping import propose

    assert (await api.post("/connectors/sheets/propose-mapping", {"sheet_id": "x"})).status_code == 409  # not connected
    await api.post("/connectors/sheets/mock-connect")
    assert (await api.post("/connectors/sheets/propose-mapping", {"sheet_id": "x"}, who="ops")).status_code == 403
    cols = (await api.post("/connectors/sheets/propose-mapping", {"sheet_id": "demo-sheet", "tab": "Deliveries"})).json()["columns"]
    m = {c["header"]: (c["meaning"], c["confidence"]) for c in cols}
    assert m["PO No"] == ("po_ref", "sure") and m["Party"] == ("customer", "sure") and m["Bal"] == ("qty_pending", "sure")
    assert m["Qty"] == ("qty_ordered", "check") and m["Disp."] == ("qty_delivered", "check") and m["Dispatch dt"] == ("delivery_date", "check")
    assert m["Remarks"][0] == "ignore"
    # value patterns: arithmetic ordered - delivered = pending, PO-looking values, company names
    grid = [["Ref", "Firm", "A", "B", "C"], ["PO-11", "Kaveri Agro Foods", 60, 55, 5], ["PO-12", "Venkat Steel Works", 120, 109, 11], ["PO 13", "Nizam Electricals", 12, 12, 0]]
    got = {c["header"]: c["meaning"] for c in await propose(grid, use_llm=False)}
    assert got == {"Ref": "po_ref", "Firm": "customer", "A": "qty_ordered", "B": "qty_delivered", "C": "qty_pending"}
    # confirm the mapping and read a user-shaped sheet through it
    async with session_scope() as s:
        c = await get_connector(s, db, "sheets")
        cfg = copy.deepcopy(c.config)
        cfg["mock"]["raw"] = [["Order#", "Buyer co", "Model", "Total", "Sent", "Left"], ["PO-777", "Kaveri Agro Foods", "Model Z", 50, 20, 30]]
        c.config = cfg
    mapping = {"Order#": "po_ref", "Buyer co": "customer", "Model": "item", "Total": "qty_ordered", "Sent": "qty_delivered", "Left": "qty_pending"}
    assert (await api.post("/connectors/sheets/config", {"spreadsheet_id": "demo-sheet", "range": "Deliveries!A1:H500", "mapping": {"Order#": "nonsense"}})).status_code == 422
    assert (await api.post("/connectors/sheets/config", {"spreadsheet_id": "demo-sheet", "range": "Deliveries!A1:H500", "mapping": mapping})).json() == {"ok": True}
    async with session_scope() as s:
        rows = await (await adapter(s, db, "sheets")).read_delivery("PO-777")
    assert rows and rows[0]["qty_delivered"] == 20 and rows[0]["customer"] == "Kaveri Agro Foods"


async def test_backfill_job_progress(api, db):
    from app.backfill import wait_idle
    from app.demo.business_seed import seed_business

    assert (await api.get("/setup/backfill")).json()["status"] == "none"
    await seed_business(db)
    assert (await api.post("/setup/backfill", {"days": 90}, who="ops")).status_code == 403
    jid = (await api.post("/setup/backfill", {"days": 90})).json()["job_id"]
    await wait_idle()
    st = (await api.get("/setup/backfill")).json()
    assert st["job_id"] == jid and st["status"] == "done"
    src = {x["name"]: x for x in st["sources"]}
    assert set(src) == {"gmail", "whatsapp", "sheets", "zoho"} and all({"name", "done", "total", "status"} <= set(x) for x in st["sources"])
    assert src["zoho"]["total"] > 30 and src["sheets"]["done"] >= 6 and src["zoho"]["status"] == "done"
    assert st["first_case_ref"] == "RG-1031"


async def test_connector_health_reports_problems_plainly(api, db):
    from app.db import session_scope
    from app.flags import set_flag

    h = {c["name"]: c for c in (await api.get("/connectors")).json()["connectors"]}
    assert h["zoho"]["health"] == "down" and h["zoho"]["error_plain"] == "Not connected yet."
    await api.post("/connectors/zoho/mock-connect")
    async with session_scope() as s:
        await set_flag(s, db, "chaos:zoho_down", True)
    h = {c["name"]: c for c in (await api.get("/connectors")).json()["connectors"]}
    assert h["zoho"]["health"] == "down" and "not responding" in h["zoho"]["error_plain"] and h["zoho"]["last_sync"]
    await api.post("/connectors/gmail/revoke")
    h = {c["name"]: c for c in (await api.get("/connectors")).json()["connectors"]}
    assert h["gmail"]["health"] == "relogin"
