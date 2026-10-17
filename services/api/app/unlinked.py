"""Unlinked inbox: intake items we could not match to a PO. Linking moves the evidence into the case (new evidence
version, open approvals expire, validator re-runs) and teaches aliases used by future matching."""
from __future__ import annotations

import re
from datetime import timedelta
from typing import Any

from sqlalchemy import select

from . import case_service as cs
from .audit import append_audit
from .business import fuzzy_customer, load_world, proof_for_node, suggestions_for
from .db import session_scope, utcnow
from .models import Case, EvidenceNode, IntakeRecord, UnlinkedItem
from .settings_service import save_alias
from .validator import normalize_ref


class UnlinkedError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


async def list_unlinked(tenant_id: str) -> list[dict[str, Any]]:
    async with session_scope() as s:
        items = (await s.execute(select(UnlinkedItem).where(UnlinkedItem.tenant_id == tenant_id, UnlinkedItem.status == "open").order_by(UnlinkedItem.received_at.desc()))).scalars().all()
        if not items:
            return []
        w = await load_world(s, tenant_id)
        names = sorted({c.get("contact_name") for c in w.contacts if c.get("contact_name")} | {cv.customer for cv in w.cases if cv.customer})
        out = []
        for it in items:
            node = await s.get(EvidenceNode, it.node_id) if it.node_id else None
            text = f"{it.preview}\n{(node.derived_text or '') if node else ''}"
            ex = dict(it.extracted or {})
            if not ex.get("customer"):
                phrase, canon, _score = fuzzy_customer(text, names)  # what was typed in the message first
                if not phrase:
                    phrase, canon, _score = fuzzy_customer(it.sender, names)
                if phrase:
                    ex["customer"] = phrase
                    ex["customer_canonical"] = canon
            proof = (proof_for_node(node) if node else None) or {"kind": "whatsapp" if it.source == "whatsapp" else "email", "label": "Message", "node_id": it.node_id}
            out.append({"id": it.id, "source": proof, "received_at": it.received_at.isoformat(), "from": it.sender, "preview": it.preview[:280],
                        "extracted": {k: ex[k] for k in ("po_ref", "customer", "qty") if ex.get(k) is not None},
                        "suggestions": suggestions_for(text, ex, w)})
        return out


async def link_item(tenant_id: str, item_id: str, case_ref: str, actor: str) -> dict[str, Any]:
    async with session_scope() as s:
        it = await s.get(UnlinkedItem, item_id)
        if it is None or it.tenant_id != tenant_id:
            raise UnlinkedError(404, "item not found")
        if it.status != "open":
            raise UnlinkedError(409, f"item is already {it.status}")
        case = (await s.execute(select(Case).where(Case.tenant_id == tenant_id, (Case.case_number == case_ref) | (Case.id == case_ref)))).scalar_one_or_none()
        if case is None:
            raise UnlinkedError(404, "case not found")
        node = await s.get(EvidenceNode, it.node_id) if it.node_id else None
        moved = []
        if node is not None:
            group = [node] + list((await s.execute(select(EvidenceNode).where(EvidenceNode.tenant_id == tenant_id, EvidenceNode.case_id.is_(None),
                                                                              EvidenceNode.source_id.like(f"{it.source_id}#att%")))).scalars().all())
            for n in group:
                clash = (await s.execute(select(EvidenceNode.id).where(EvidenceNode.tenant_id == tenant_id, EvidenceNode.case_id == case.id,
                                                                     EvidenceNode.source == n.source, EvidenceNode.source_id == n.source_id))).first()
                if clash:
                    continue
                n.case_id = case.id
                flds = dict(n.fields or {})
                if not flds.get("po_ref") and case.po_ref:
                    flds["po_ref"] = case.po_ref
                    flds["po_ref_linked_by"] = actor
                n.fields = flds
                moved.append(n.id)
            if moved and case.state != "CLOSED":
                case.evidence_version = (case.evidence_version or 0) + 1
                for nid in moved:
                    (await s.get(EvidenceNode, nid)).evidence_version = case.evidence_version
                await cs.expire_approvals_on_evidence_change(s, case, reason=f"linked unlinked item {it.id[:8]} by {actor}")
        rec = (await s.execute(select(IntakeRecord).where(IntakeRecord.tenant_id == tenant_id, IntakeRecord.source == it.source, IntakeRecord.source_id == it.source_id))).scalar_one_or_none()
        if rec:
            rec.case_id, rec.status = case.id, "accepted"
        it.status, it.linked_case_id, it.decided_by, it.decided_at = "linked", case.id, actor, utcnow()
        # ---- alias learning
        learned = []
        ex = it.extracted or {}
        f = await cs.compute_facts(s, case)
        canon_cust = f.customer_name or case.customer
        if ex.get("po_ref") and case.po_ref and normalize_ref(ex["po_ref"]) != case.po_ref_norm:
            if await save_alias(s, tenant_id, "po", ex["po_ref"], case.po_ref, actor):
                learned.append({"kind": "po", "alias": ex["po_ref"], "canonical": case.po_ref})
        digits = re.sub(r"\D", "", case.po_ref_norm or "")
        text = f"{it.preview}\n{(node.derived_text or '') if node else ''}"
        if digits and not ex.get("po_ref") and re.search(rf"(?<![\w-]){digits}(?![\w-])", text):
            if await save_alias(s, tenant_id, "po", digits, case.po_ref, actor):
                learned.append({"kind": "po", "alias": digits, "canonical": case.po_ref})
        typed = ex.get("customer")
        if not typed and canon_cust:
            typed, _c, _sc = fuzzy_customer(text, [canon_cust])
        if typed and canon_cust and typed.strip().lower() != canon_cust.strip().lower():
            if await save_alias(s, tenant_id, "customer", typed, canon_cust, actor):
                learned.append({"kind": "customer", "alias": typed, "canonical": canon_cust})
        if (it.extracted or {}).get("chat_id"):
            from . import chat_memory

            await chat_memory.remember(s, tenant_id, it.extracted["chat_id"], case=case, fields=dict(node.fields or {}) if node else {},
                                       text=it.preview or "", by=actor)
        await append_audit(s, tenant_id, "unlinked.linked", actor, {"item_id": it.id, "nodes": moved, "aliases": learned, "evidence_version": case.evidence_version},
                           case.id, case.correlation_id)
        case_id, closed = case.id, case.state == "CLOSED"
    if not closed:
        from .jobs import enqueue_advance

        await enqueue_advance(case_id)
    return {"ok": True, "case_ref": case_ref, "aliases": learned, "moved_nodes": moved}


async def ignore_item(tenant_id: str, item_id: str, actor: str) -> dict[str, Any]:
    async with session_scope() as s:
        it = await s.get(UnlinkedItem, item_id)
        if it is None or it.tenant_id != tenant_id:
            raise UnlinkedError(404, "item not found")
        it.status, it.decided_by, it.decided_at = "ignored", actor, utcnow()
        await append_audit(s, tenant_id, "unlinked.ignored", actor, {"item_id": it.id})
    return {"ok": True}


async def answer_which_po(tenant_id: str, chat_id: str, case_id: str, actor: str = "whatsapp-answer") -> list[dict[str, Any]]:
    """A watched chat answered "Which PO?" with a PO: link that chat's recent unlinked items to the case."""
    since = utcnow() - timedelta(hours=3)
    async with session_scope() as s:
        items = (await s.execute(select(UnlinkedItem).where(UnlinkedItem.tenant_id == tenant_id, UnlinkedItem.status == "open", UnlinkedItem.source == "whatsapp",
                                                            UnlinkedItem.created_at >= since))).scalars().all()
        ids = [i.id for i in items if (i.extracted or {}).get("chat_id") == chat_id]
        case = await s.get(Case, case_id)
        ref = case.case_number if case else None
    out = []
    for i in ids:
        if ref:
            out.append(await link_item(tenant_id, i, ref, actor))
    return out
