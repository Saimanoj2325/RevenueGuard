"""WhatsApp message lifecycle (CONTRACT_V3 §2, API side): edits, deletes, resends.

  edit   -> old text kept in fields.versions[], node text = new text, status "edited", evidence_version bump (an
            approval on the old facts expires by the existing rule), the LLM re-reads it, the timeline agent re-runs.
  delete -> status "deleted": content kept for audit, hidden from facts, timeline agent re-runs.
  billed -> if the case already has an invoice: "Needs a check" (we never change an invoice on our own).
  out of order -> an edit/delete that arrives before its message waits up to 10 minutes for it, then is dropped.
Resend/duplicate detection runs inside intake (find_resend below)."""
from __future__ import annotations

import base64
import binascii
import hashlib
import io
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select

from . import case_service as cs
from .audit import append_audit
from .db import session_scope, utcnow
from .flags import get_flag, set_flag
from .models import Action, Case, EvidenceNode, IntakeRecord, KvFlag, WaMessage
from .observability import get_logger

log = get_logger("lifecycle")
PENDING_MINUTES = 10
PHASH_MAX_DISTANCE = 6
MEDIA_DUP_DAYS = 30
TEXT_DUP_MINUTES = 10


# ------------------------------------------------------------------ hashes (resend detection)
def sha256_hex(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def wa_sha_to_hex(v: str | None) -> str | None:
    """wa-bridge sends Baileys fileSha256 as base64; we compare hex."""
    if not v:
        return None
    try:
        b = base64.b64decode(v + "=" * (-len(v) % 4))
        return b.hex() if len(b) == 32 else None
    except (binascii.Error, ValueError):
        return None


def phash_hex(raw: bytes, mime: str | None) -> str | None:
    if not (mime or "").startswith("image/"):
        return None
    try:
        import imagehash
        from PIL import Image

        return str(imagehash.phash(Image.open(io.BytesIO(raw))))
    except Exception as e:  # noqa: BLE001  (not an image we can open: no perceptual hash)
        log.info("lifecycle.phash_failed", error=str(e)[:120])
        return None


def phash_distance(a: str, b: str) -> int:
    import imagehash

    return imagehash.hex_to_hash(a) - imagehash.hex_to_hash(b)


def _norm_text(t: str) -> str:
    return " ".join((t or "").lower().split())


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def find_resend(s, tenant_id: str, *, chat_id: str | None, case_id: str | None, media: list[dict[str, Any]], text: str,
                      quoted_id: str | None, forwarded: bool, ts: datetime) -> tuple[EvidenceNode, str] | None:
    """Same photo (sha256 or phash <= 6) in this chat/case within 30 days, or the same text with the same quoted/forwarded
    within 10 minutes. Returns (original node, plain reason) or None."""
    since = utcnow() - timedelta(days=MEDIA_DUP_DAYS)
    rows = (await s.execute(select(EvidenceNode).where(EvidenceNode.tenant_id == tenant_id, EvidenceNode.source.in_(("whatsapp", "media")),
                                                       EvidenceNode.created_at >= since, EvidenceNode.quarantined.is_(False))
                            .order_by(EvidenceNode.created_at.asc()).limit(3000))).scalars().all()
    scope = [n for n in rows if (n.fields or {}).get("status") not in ("deleted",)
             and ((chat_id and (n.fields or {}).get("chat_id") == chat_id) or (case_id and n.case_id == case_id))]
    originals = [n for n in scope if (n.fields or {}).get("status") != "duplicate"]
    for m in media:
        shas = {x for x in (m.get("sha256"), m.get("sha256_sent")) if x}
        for n in originals:
            f = n.fields or {}
            if shas & {x for x in (f.get("media_sha256"), f.get("media_sha256_sent")) if x}:
                return n, "the same photo/file was sent again"
        if m.get("phash"):
            for n in originals:
                ph = (n.fields or {}).get("media_phash")
                if ph and phash_distance(ph, m["phash"]) <= PHASH_MAX_DISTANCE:
                    return n, "a near-identical photo was sent again"
    t = _norm_text(text)
    if t and not media:
        cutoff = _aware(ts) - timedelta(minutes=TEXT_DUP_MINUTES)
        for n in reversed(originals):
            f = n.fields or {}
            if _aware(n.ts) and _aware(n.ts) >= cutoff and _norm_text(n.excerpt) == t and f.get("quoted_id") == quoted_id and bool(f.get("forwarded")) == bool(forwarded):
                return n, "the same message was sent again within 10 minutes"
    return None


# ------------------------------------------------------------------ billed check
async def is_billed(s, case: Case) -> bool:
    act = (await s.execute(select(Action.id).where(Action.case_id == case.id, Action.type == "create_invoice", Action.status == "succeeded").limit(1))).first()
    if act:
        return True
    f = await cs.compute_facts(s, case)
    return bool(f.duplicates)


async def _needs_check_after_billing(s, case: Case, what: str, node_id: str) -> None:
    from .timeline import _k

    reason = f"Message {what} after billing"
    await set_flag(s, case.tenant_id, _k("tl_check", case.id), {"reason": reason, "node_id": node_id, "at": utcnow().isoformat()})
    await cs.open_escalation(s, case, "edited_after_billing", {"message": f"{reason}. The invoice was NOT changed; please check.", "node_id": node_id})
    if case.state not in ("CLOSED", "EXECUTING", "VERIFYING", "ESCALATED"):
        await cs.transition(s, case, "ESCALATED", f"needs a check: {reason.lower()}", {"node_id": node_id})


# ------------------------------------------------------------------ edit / delete
def _parse_ts(v: Any) -> datetime:
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / (1000 if v > 1e12 else 1), tz=timezone.utc)
    if isinstance(v, str):
        try:
            return _aware(datetime.fromisoformat(v.replace("Z", "+00:00")))
        except ValueError:
            pass
    return utcnow()


async def handle(tenant_id: str, ev: dict[str, Any]) -> dict[str, Any]:
    """POST /internal/wa-events with type message_edit | message_delete."""
    typ = ev.get("type")
    body = ev.get("edit") if typ == "message_edit" else ev.get("delete")
    if not isinstance(body, dict) or not body.get("id") or not body.get("chat_id"):
        return {"ok": False, "error": f"{typ}: id and chat_id are required"}
    if typ == "message_edit" and not isinstance(body.get("text"), str):
        return {"ok": False, "error": "message_edit: text is required"}
    async with session_scope() as s:
        rec = (await s.execute(select(IntakeRecord).where(IntakeRecord.tenant_id == tenant_id, IntakeRecord.source == "whatsapp",
                                                         IntakeRecord.source_id == body["id"]))).scalar_one_or_none()
        if rec is None:
            # arrived before its message: keep it for up to 10 minutes
            key = f"wa_pending:{str(body['id'])[:68]}"
            await set_flag(s, tenant_id, key, {"type": typ, "body": body, "received_at": utcnow().isoformat()})
            await append_audit(s, tenant_id, "wa.lifecycle_pending", "wa-bridge", {"type": typ, "id": body["id"]})
            return {"ok": True, "status": "pending", "reason": "original message not seen yet; kept for 10 minutes"}
    return await apply(tenant_id, typ, body)


async def apply(tenant_id: str, typ: str, body: dict[str, Any]) -> dict[str, Any]:
    from .intake import case_context
    from .extraction import extract_fields

    when = _parse_ts(body.get("ts"))
    async with session_scope() as s:
        rec = (await s.execute(select(IntakeRecord).where(IntakeRecord.tenant_id == tenant_id, IntakeRecord.source == "whatsapp",
                                                         IntakeRecord.source_id == body["id"]))).scalar_one_or_none()
        wa = (await s.execute(select(WaMessage).where(WaMessage.tenant_id == tenant_id, WaMessage.message_id == body["id"]))).scalar_one_or_none()
        if rec is None or rec.node_id is None:
            return {"ok": False, "error": "original message not found"}
        if wa is not None and wa.chat_id != body["chat_id"]:
            await append_audit(s, tenant_id, "wa.lifecycle_rejected", "wa-bridge", {"type": typ, "id": body["id"], "reason": "chat mismatch"})
            return {"ok": False, "error": "chat does not match the original message"}
        node = await s.get(EvidenceNode, rec.node_id)
        if node is None:
            return {"ok": False, "error": "original message not found"}
        case = await s.get(Case, node.case_id) if node.case_id else None
        f = dict(node.fields or {})
        if f.get("status") == "deleted":
            return {"ok": True, "status": "ignored", "reason": "message already deleted"}
        old_text = node.excerpt or ""
        billed = await is_billed(s, case) if case is not None else False
        if typ == "message_edit":
            new_text = body["text"]
            if new_text.strip() == old_text.strip():
                return {"ok": True, "status": "unchanged"}
            versions = list(f.get("versions") or [])
            versions.append({"text": old_text, "at": (node.ts or node.created_at).isoformat() if (node.ts or node.created_at) else None,
                             "replaced_at": when.isoformat()})
            node.excerpt = new_text[:4000]
            if wa is not None:
                wa.text = new_text
            # the LLM re-reads the new words with the case in view (never regex in live mode: pending_read when no model)
            read_text = "\n".join(x for x in (new_text, node.derived_text) if x)
            context = await case_context(s, case, body["chat_id"], node.source_id) if case is not None else None
            fresh, meta = await extract_fields(read_text, source="whatsapp", source_id=f"{node.source_id}#edit{len(versions)}", session=s,
                                               tenant_id=tenant_id, context=context)
            keep = {k: f[k] for k in ("chat_id", "quoted_id", "forwarded", "media_sha256", "media_sha256_sent", "media_phash", "po_ref_inferred") if k in f}
            if case is not None and not fresh.get("po_ref") and case.po_ref:
                fresh["po_ref"] = case.po_ref
            node.fields = {**fresh, **keep, "versions": versions, "status": "edited", "edited_at": when.isoformat()}
            what = "edited"
        else:
            node.fields = {**f, "status": "deleted", "deleted_at": when.isoformat()}
            what = "deleted"
        if case is not None:
            if case.state != "CLOSED":
                case.evidence_version = (case.evidence_version or 0) + 1
                node.evidence_version = case.evidence_version
                await cs.expire_approvals_on_evidence_change(s, case, reason=f"message {what} on WhatsApp ({node.id[:8]})")
            if billed:
                await _needs_check_after_billing(s, case, what, node.id)
            await append_audit(s, tenant_id, f"wa.message_{what}", "wa-bridge", {"node_id": node.id, "id": body["id"], "billed": billed}, case.id, case.correlation_id)
            cs.queue_event(s, tenant_id, {"type": "case.updated", "case_id": case.id, "case_number": case.case_number, "state": case.state})
        else:
            await append_audit(s, tenant_id, f"wa.message_{what}", "wa-bridge", {"node_id": node.id, "id": body["id"]})
        case_id = case.id if case else None
        trig = {"kind": "edit" if typ == "message_edit" else "delete", "node_id": node.id, "text": node.excerpt if typ == "message_edit" else "",
                "old_text": old_text, "chat_key": body["chat_id"], "source": "whatsapp", "billed": billed}
    out: dict[str, Any] = {"ok": True, "status": what, "case_id": case_id, "node_id": trig["node_id"], "billed": billed}
    if case_id:
        from .jobs import enqueue_advance
        from .timeline import run_timeline

        res = await run_timeline(case_id, trig)
        out["timeline"] = {k: res.get(k) for k in ("status", "verified", "failed_checks")}
        await enqueue_advance(case_id)
    return out


async def flush_pending_for(tenant_id: str, msg_id: str) -> list[dict[str, Any]]:
    """The original message just arrived: apply an edit/delete that was waiting for it."""
    key = f"wa_pending:{str(msg_id)[:68]}"
    async with session_scope() as s:
        v = await get_flag(s, tenant_id, key, None)
        if not v:
            return []
        row = await s.get(KvFlag, (tenant_id, key))
        await s.delete(row)
    return [await apply(tenant_id, v["type"], v["body"])]


async def sweep_pending() -> int:
    """Drop edits/deletes whose message never arrived within 10 minutes (audited)."""
    cutoff = utcnow() - timedelta(minutes=PENDING_MINUTES)
    dropped = 0
    async with session_scope() as s:
        rows = (await s.execute(select(KvFlag).where(KvFlag.key.like("wa_pending:%")))).scalars().all()
        for r in rows:
            at = _aware(datetime.fromisoformat((r.value or {}).get("received_at") or utcnow().isoformat()))
            if at < cutoff:
                await append_audit(s, r.tenant_id, "wa.lifecycle_dropped", "system", {"key": r.key, "reason": "original message did not arrive within 10 minutes"})
                await s.delete(r)
                dropped += 1
    return dropped
