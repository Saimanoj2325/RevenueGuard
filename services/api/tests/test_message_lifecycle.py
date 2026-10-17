"""Message lifecycle (CONTRACT_V3 §2): edits, deletes, resends, out-of-order events; plus the timeline agent's view
of messy chats (two challans, two POs in one chat, Hinglish extra delivery). Live mode with the scripted fake model."""
from __future__ import annotations

import base64
import io
import json

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

import app.main  # noqa: F401

from .helpers import case_by_ref, suppress
from .test_timeline_agent import CHAT, facts, order, summary, wa
from .timeline_fakes import install, smart


def png(seed: int, tweak: bool = False) -> str:
    """A 'challan photo'. tweak=True is the same paper photographed again (slightly brighter, resized)."""
    import random

    from PIL import Image, ImageEnhance

    rnd = random.Random(seed)
    img = Image.new("L", (16, 16))
    img.putdata([rnd.randrange(256) for _ in range(256)])
    img = img.resize((256, 256), Image.NEAREST).convert("RGB")
    if tweak:
        img = ImageEnhance.Brightness(img).enhance(1.08).resize((250, 250))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


async def edit(tid: str, mid: str, text: str, chat: str = CHAT) -> dict:
    from app.sync import handle_wa_event

    return await handle_wa_event(tid, {"type": "message_edit", "edit": {"id": mid, "chat_id": chat, "from": "919800000099@s.whatsapp.net", "ts": 1760000000, "text": text}})


async def delete(tid: str, mid: str, chat: str = CHAT) -> dict:
    from app.sync import handle_wa_event

    return await handle_wa_event(tid, {"type": "message_delete", "delete": {"id": mid, "chat_id": chat, "from": "919800000099@s.whatsapp.net", "ts": 1760000000}})


async def _pending_approval(po: str = "PO-7101"):
    """An approval on the current facts (as the orchestrator would have created it)."""
    from app.db import session_scope
    from app.models import Approval, Case, Proposal

    c = await case_by_ref(po)
    async with session_scope() as s:
        case = await s.get(Case, c.id)
        p = Proposal(tenant_id=case.tenant_id, case_id=case.id, version=1, payload={"type": "create_invoice", "amount": 60000}, payload_hash="h" * 64,
                     evidence_version=case.evidence_version, status="active")
        s.add(p)
        await s.flush()
        ap = Approval(tenant_id=case.tenant_id, case_id=case.id, proposal_id=p.id, payload_hash=p.payload_hash, evidence_version=case.evidence_version,
                      amount=60000, status="pending")
        s.add(ap)
        await s.flush()
        return ap.id


async def test_edit_60_to_100_updates_total_and_expires_approval(db, monkeypatch):
    from app.db import session_scope
    from app.models import Approval, EvidenceNode

    install(monkeypatch, smart)
    async with suppress():
        await order(db)
        r = await wa(db, "w1", "CH-1: 60 delivered for PO-7101")
        assert (await facts()).delivered_qty == 60
        ap_id = await _pending_approval()
        out = await edit(db, "w1", "CH-1: 100 delivered for PO-7101")
        assert out["status"] == "edited" and out["timeline"]["verified"], out
        f = await facts()
    assert f.delivered_qty == 100 and str(f.billable["amount"]) == "100000.00"
    async with session_scope() as s:
        ap = await s.get(Approval, ap_id)
        node = await s.get(EvidenceNode, r["node_ids"][0])
    assert ap.status == "expired" and "edited" in ap.expires_reason
    assert node.fields["status"] == "edited" and node.fields["versions"][0]["text"] == "CH-1: 60 delivered for PO-7101" and "100" in node.excerpt
    row = next(x for x in (await summary())["timeline"] if x["node_id"] == node.id)
    assert row["status"] == "edited" and row["versions"][0]["text"].startswith("CH-1: 60")


async def test_delete_removes_the_count(db, monkeypatch):
    install(monkeypatch, smart)
    async with suppress():
        await order(db)
        await wa(db, "w1", "CH-1: 60 delivered for PO-7101")
        await wa(db, "w2", "CH-2: 40 delivered for PO-7101")
        assert (await facts()).delivered_qty == 100
        out = await delete(db, "w2")
        assert out["status"] == "deleted" and out["timeline"]["verified"]
        assert (await facts()).delivered_qty == 60
    row = [x for x in (await summary())["timeline"] if x["status"] == "deleted"]
    assert len(row) == 1 and row[0]["role"] == "ignored" and "40" in row[0]["text"]  # kept for audit, not counted


async def test_edit_after_invoice_needs_a_check_and_never_touches_the_invoice(db, monkeypatch):
    from app import case_service as cs
    from app.db import session_scope
    from app.models import Case, Escalation, EvidenceNode

    install(monkeypatch, smart)
    async with suppress():
        await order(db)
        await wa(db, "w1", "CH-1: 60 delivered for PO-7101")
        c = await case_by_ref("PO-7101")
        async with session_scope() as s:  # INV-9001 already billed the 60 in Zoho
            case = await s.get(Case, c.id)
            inv, _ = await cs.add_evidence(s, case, case.tenant_id, kind="invoice", source="zoho", source_id="inv:9001", title="Zoho invoice INV-9001 ref PO-7101",
                                           fields={"invoice_id": "9001", "invoice_number": "INV-9001", "reference_number": "PO-7101", "po_ref": "PO-7101", "total": 70800, "qty": 60},
                                           actor="test", material=False)
            inv_id, before = inv.id, dict(inv.fields)
        out = await edit(db, "w1", "CH-1: 100 delivered for PO-7101")
    assert out["billed"] is True
    s_ = await summary()
    assert s_["confidence"] == "needs_check" and "edited after billing" in s_["confidence_reason"] and "not changed" in s_["confidence_reason"]
    async with session_scope() as s:
        assert (await s.get(EvidenceNode, inv_id)).fields == before
        esc = (await s.execute(select(Escalation).where(Escalation.case_id == c.id))).scalars().all()
        assert any(e.reason == "edited_after_billing" for e in esc)
        assert (await s.get(Case, c.id)).state == "ESCALATED"


async def test_resent_identical_photo_is_a_duplicate_and_not_counted(db, monkeypatch):
    install(monkeypatch, smart)
    img = png(1)
    async with suppress():
        await order(db)
        await wa(db, "p1", "CH-1 60 delivered PO-7101", media={"mime": "image/png", "filename": "challan.png", "base64": img})
        r = await wa(db, "p2", "CH-1 60 delivered PO-7101", media={"mime": "image/png", "filename": "challan.png", "base64": img})
        assert r["link"] == "duplicate" and r["timeline"]["verified"] and r["timeline"]["meaning"] == "duplicate"
        assert (await facts()).delivered_qty == 60
    rows = (await summary())["timeline"]
    dup = next(x for x in rows if x["status"] == "duplicate")
    assert dup["duplicate_of"] == next(x for x in rows if x["status"] == "active" and x["kind"] != "order_email" and x["qty"] != 100)["node_id"]


async def test_wa_sha256_from_the_bridge_also_marks_a_resend(db, monkeypatch):
    import hashlib

    install(monkeypatch, smart)
    img = png(5)
    sha = base64.b64encode(hashlib.sha256(base64.b64decode(img)).digest()).decode()
    async with suppress():
        await order(db)
        await wa(db, "p1", "CH-1 60 delivered PO-7101", media={"mime": "image/png", "filename": "c.png", "base64": img, "sha256": sha})
        r = await wa(db, "p2", "CH-1 60 delivered PO-7101", media={"mime": "image/png", "filename": "c.png", "base64": img, "sha256": sha})
    assert r["link"] == "duplicate"


async def test_near_identical_rephoto_is_a_duplicate_by_phash(db, monkeypatch):
    from app.lifecycle import phash_distance, phash_hex

    a, b, other = png(1), png(1, tweak=True), png(2)
    assert phash_distance(phash_hex(base64.b64decode(a), "image/png"), phash_hex(base64.b64decode(b), "image/png")) <= 6
    assert phash_distance(phash_hex(base64.b64decode(a), "image/png"), phash_hex(base64.b64decode(other), "image/png")) > 6
    install(monkeypatch, smart)
    async with suppress():
        await order(db)
        await wa(db, "p1", "CH-1 60 delivered PO-7101", media={"mime": "image/png", "filename": "challan.png", "base64": a})
        r = await wa(db, "p2", "CH-1 60 delivered PO-7101", media={"mime": "image/png", "filename": "challan2.png", "base64": b})
        assert r["link"] == "duplicate"
        r3 = await wa(db, "p3", "CH-2 40 delivered PO-7101", media={"mime": "image/png", "filename": "challan3.png", "base64": other})
        assert r3["link"] != "duplicate"
        assert (await facts()).delivered_qty == 100


async def test_same_text_resent_within_10_minutes_is_a_duplicate(db, monkeypatch):
    install(monkeypatch, smart)
    async with suppress():
        await order(db)
        await wa(db, "t1", "CH-1: 60 delivered for PO-7101")
        r = await wa(db, "t2", "CH-1: 60 delivered for PO-7101")
        assert r["link"] == "duplicate"
        assert (await facts()).delivered_qty == 60


async def test_two_challans_60_and_40_make_100_with_gst_preview(db, monkeypatch):
    install(monkeypatch, smart)
    async with suppress():
        await order(db)
        await wa(db, "c1", "Challan CH-101: 60 delivered for PO-7101")
        r = await wa(db, "c2", "Challan CH-102: 40 delivered for PO-7101")
        assert r["timeline"]["verified"]
        f = await facts()
    assert f.delivered_qty == 100 and str(f.billable["amount"]) == "100000.00"
    s = await summary()
    gst = s["invoice_preview"]
    assert gst["taxable"] == 100000 and gst["tax_total"] == 18000 and gst["total"] == 118000, gst
    assert s["timeline_decision"]["delivered_total"] == 100 and s["timeline_decision"]["verified"]


async def test_two_open_pos_in_one_chat_asks_which_po(db, monkeypatch):
    install(monkeypatch, smart)
    async with suppress():
        await order(db, "PO-7201")
        await order(db, "PO-7202")
        await wa(db, "x1", "PO-7201: 20 delivered")
        await wa(db, "x2", "PO-7202: 30 delivered")
        r = await wa(db, "x3", "40 delivered")
    assert r["status"] == "unlinked" and r["link"] == "ambiguous" and r["case_id"] is None, r
    assert (await facts("PO-7201")).delivered_qty == 20 and (await facts("PO-7202")).delivered_qty == 30  # nothing guessed


async def test_hinglish_aur_40_aa_gaye_is_an_extra_delivery(db, monkeypatch):
    install(monkeypatch, smart)
    async with suppress():
        await order(db)
        await wa(db, "h1", "CH-1: 60 delivered for PO-7101")
        r = await wa(db, "h2", "aur 40 aa gaye")
        assert r["status"] == "accepted" and r["timeline"]["meaning"] == "extra_delivery" and r["timeline"]["verified"], r
        assert (await facts()).delivered_qty == 100


async def test_edit_before_its_message_waits_then_applies(db, monkeypatch):
    install(monkeypatch, smart)
    async with suppress():
        await order(db)
        early = await edit(db, "late1", "CH-1: 100 delivered for PO-7101")
        assert early["status"] == "pending"
        await wa(db, "late1", "CH-1: 60 delivered for PO-7101", chat=CHAT)
        assert (await facts()).delivered_qty == 100


async def test_wa_events_endpoint_accepts_edit_and_delete(db, monkeypatch):
    from app.security import sign_headers

    install(monkeypatch, smart)
    async with suppress():
        await order(db)
        await wa(db, "e1", "CH-1: 60 delivered for PO-7101")
        async with AsyncClient(transport=ASGITransport(app=app.main.app), base_url="http://t") as c:
            raw = json.dumps({"type": "message_delete", "delete": {"id": "e1", "chat_id": CHAT, "from": "x", "ts": 1}}).encode()
            r = await c.post("/internal/wa-events", content=raw, headers=sign_headers(raw))
            assert r.status_code == 200 and r.json()["status"] == "deleted"
            bad = json.dumps({"type": "message_edit", "edit": {"id": "e1"}}).encode()
            assert (await c.post("/internal/wa-events", content=bad, headers=sign_headers(bad))).status_code == 422
        assert (await facts()).delivered_qty is None


async def test_demo_mode_stand_in_still_hides_deleted_messages(db):
    """Demo mode, no model key: the labelled stand-in shows a decision; the static rules drive facts and skip deleted."""
    async with suppress():
        await order(db)
        await wa(db, "d1", "Challan CH-1: 60 delivered for PO-7101")
        await wa(db, "d2", "Challan CH-2: 40 delivered for PO-7101")
        assert (await facts()).delivered_qty == 100
        await delete(db, "d2")
        assert (await facts()).delivered_qty == 60
    td = (await summary())["timeline_decision"]
    assert td["source"] == "demo-stand-in" and td["delivered_total"] == 60
