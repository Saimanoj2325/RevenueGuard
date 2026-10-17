"""Agent tools (POST /tools/<name>). Read-only by construction: no tool can write to Zoho/WhatsApp/Gmail.
Allow-lists are enforced here (API side) in addition to the Harness tool-policy plugin."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from .. import case_service as cs
from .. import laya_client
from ..audit import append_audit
from ..connectors.base import ConnectorError, ConnectorUnavailable, NotConnected
from ..connectors.registry import adapter
from ..extraction import extract_fields, regex_extract
from ..models import Case, ToolCall
from ..observability import get_logger
from ..security import sha256_text
from ..validator import normalize_ref, ref_variants, refs_match, text_mentions_ref

log = get_logger("tools")

EVIDENCE_READ_TOOLS = [
    "gmail_search", "whatsapp_search", "sheets_read_delivery", "drive_read_doc",
    "zoho_get_salesorders", "zoho_get_invoices", "zoho_get_payments", "bank_get_payments", "read_chat_memory",
]
ALLOW_LIST: dict[str, set[str]] = {
    "triage": {"laya_decide", "extract_fields", "case_attach_or_open"},
    "evidence": set(EVIDENCE_READ_TOOLS) | {"evidence_add"},
    "investigation": set(EVIDENCE_READ_TOOLS) | {"search_alt_ids", "search_credit_notes", "compute_billable", "get_billing_rules", "evidence_add"},
    "resolution": {"draft_action", "risk_score", "compute_billable"},
    # CONTRACT_V3 §1: reads the timeline + memory, writes only chat memory and its own decision (never Zoho/WhatsApp/Gmail)
    "timeline": {"read_chat_memory", "search_cases", "read_case_timeline", "whatsapp_search", "sheets_read_delivery", "write_chat_memory", "propose_timeline"},
}


class ToolDenied(Exception):
    pass


@dataclass
class ToolCtx:
    session: AsyncSession
    case: Case
    tenant_id: str
    agent: str
    run_id: str | None = None
    correlation_id: str | None = None


@dataclass
class ToolResult:
    ok: bool
    data: Any = None
    evidence_node_ids: list[str] = field(default_factory=list)
    error: str | None = None
    connector_down: str | None = None

    def json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"ok": self.ok, "data": self.data}
        if self.evidence_node_ids:
            out["evidence_node_ids"] = self.evidence_node_ids
        if self.error:
            out["error"] = self.error
        if self.connector_down:
            out["connector_down"] = self.connector_down
        return out


ToolFn = Callable[[ToolCtx, dict[str, Any]], Awaitable[ToolResult]]
TOOLS: dict[str, ToolFn] = {}


def tool(name: str):
    def deco(fn: ToolFn) -> ToolFn:
        TOOLS[name] = fn
        return fn

    return deco


def _ref(ctx: ToolCtx, args: dict[str, Any]) -> str | None:
    return args.get("ref") or args.get("po") or args.get("po_ref") or args.get("query") or ctx.case.po_ref


def _parse_ts(v: Any) -> datetime | None:
    if not v:
        return None
    if isinstance(v, datetime):
        return v
    for fmt in (None, "%Y-%m-%d %H:%M", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            dt = datetime.fromisoformat(str(v).replace("Z", "+00:00")) if fmt is None else datetime.strptime(str(v), fmt)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


async def _add(ctx: ToolCtx, **kw) -> str:
    node, _ = await cs.add_evidence(ctx.session, ctx.case, ctx.tenant_id, actor=f"agent:{ctx.agent}", **kw)
    return node.id


async def _negative(ctx: ToolCtx, tool_name: str, source: str, searched: str | None, summary: str, **extra: Any) -> str:
    """Record a negative finding ("searched X, found nothing") as a citable, non-material evidence node.
    The validator never derives facts from it (no po_ref/qty fields), but resolution claims such as "no invoice
    exists for PO-185" can cite it, and the evidence guard sees an evidence id for every tool call."""
    key = normalize_ref(searched) if searched else "-"
    return await _add(ctx, kind="search_result", source=source, source_id=f"neg:{tool_name}:{key}:v{ctx.case.evidence_version}",
                      title=f"Negative finding · {tool_name}: {summary}"[:300], excerpt=summary,
                      fields={"negative_finding": True, "tool": tool_name, "searched_ref": searched, "found": 0, **extra}, material=False)


# ------------------------------------------------------------------ triage tools
@tool("laya_decide")
async def t_laya(ctx, args):
    qs = args.get("questions")
    if not qs:
        qs = laya_client.INJECTION_QUESTIONS if args.get("question_set") == "injection" else laya_client.TRIAGE_QUESTIONS
    state = args.get("state")
    if not state:
        snap = await cs.snapshot(ctx.session, ctx.case)
        state = "\n".join(e["content"] for e in snap["evidence"])[:6000]
    res = await laya_client.decide(state, qs)
    return ToolResult(True, res)


@tool("extract_fields")
async def t_extract(ctx, args):
    text = args.get("text")
    if not text:
        snap = await cs.snapshot(ctx.session, ctx.case)
        text = "\n".join(e["content"] for e in snap["evidence"])[:8000]
    fields, meta = await extract_fields(text, source="case", source_id=ctx.case.case_number, session=ctx.session, tenant_id=ctx.tenant_id, case_id=ctx.case.id)
    return ToolResult(True, {"fields": fields, "meta": meta})


@tool("case_attach_or_open")
async def t_attach(ctx, args):
    c = ctx.case
    refs = args.get("refs") if isinstance(args.get("refs"), dict) else {}  # harness schema: {refs:{po, customer, amount, qty}}
    po = args.get("po") or args.get("po_ref") or refs.get("po")
    if po and not c.po_ref:
        c.po_ref, c.po_ref_norm = po, normalize_ref(po)
    customer = args.get("customer") or refs.get("customer")
    if customer and not c.customer:
        c.customer = customer
    return ToolResult(True, {"case_id": c.id, "case_number": c.case_number, "po_ref": c.po_ref, "attached": True})


# ------------------------------------------------------------------ evidence read tools
async def _connector_call(name: str, fn):
    try:
        return await fn(), None
    except (ConnectorUnavailable, NotConnected) as e:
        return None, (name, str(e))


@tool("gmail_search")
async def t_gmail(ctx, args):
    ref = _ref(ctx, args)
    query = args.get("query") or ref or ""
    async def go():
        return await (await adapter(ctx.session, ctx.tenant_id, "gmail")).search(query)
    msgs, err = await _connector_call("gmail", go)
    if err:
        return ToolResult(False, error=err[1], connector_down="gmail")
    ids = []
    for m in msgs:
        text = f"{m.get('subject','')}\n{m.get('text','')}"
        if ref and not text_mentions_ref(text, ref):
            continue
        from ..models import IntakeRecord
        from sqlalchemy import select

        quarantined = (await ctx.session.execute(select(IntakeRecord.status).where(IntakeRecord.tenant_id == ctx.tenant_id, IntakeRecord.source == "gmail", IntakeRecord.source_id == m["id"]))).scalar_one_or_none() == "quarantined"
        if quarantined:
            continue  # quarantined at intake; never re-admitted via search
        f = regex_extract(text)
        ids.append(await _add(ctx, kind="email", source="gmail", source_id=m["id"], title=m.get("subject") or "(no subject)", excerpt=text[:1500], fields=f, ts=_parse_ts(m.get("date"))))
    if not ids:
        ids.append(await _negative(ctx, "gmail_search", "gmail", ref or query, f"no Gmail message mentions {ref or query!r}"))
    return ToolResult(True, {"count": len(msgs), "matched": len(ids), "messages": [{"id": m["id"], "subject": m.get("subject")} for m in msgs[:10]]}, ids)


@tool("whatsapp_search")
async def t_wa(ctx, args):
    if args.get("text") and not args.get("q"):
        args = {**args, "q": args["text"]}  # timeline agent arg names (chat_key, text, since)
    ref = args.get("q") or args.get("ref") or ctx.case.po_ref
    chat = args.get("chat") or args.get("chat_key")
    async def go():
        a = await adapter(ctx.session, ctx.tenant_id, "whatsapp")
        return await a.search(q=args.get("q"), chat=chat, since=args.get("since"))
    msgs, err = await _connector_call("whatsapp", go)
    if err:
        return ToolResult(False, error=err[1], connector_down="whatsapp")
    ids = []
    for m in msgs:
        text = "\n".join(x for x in (m.get("text"), m.get("derived_text")) if x)
        if ref and args.get("q") is None and not text_mentions_ref(text, ref):
            continue
        f = regex_extract(text)
        if f.get("po_ref") and ctx.case.po_ref and not refs_match(f["po_ref"], ctx.case.po_ref):
            continue
        ids.append(await _add(ctx, kind="chat_message", source="whatsapp", source_id=m["id"], title=f"WhatsApp · {m.get('from_name','')}", excerpt=text[:1500], fields=f, ts=_parse_ts(m.get("ts"))))
    if not ids:
        ids.append(await _negative(ctx, "whatsapp_search", "whatsapp", ref, f"no WhatsApp message matches {ref!r}"))
    return ToolResult(True, {"count": len(msgs), "matched": len(ids)}, ids)


@tool("sheets_read_delivery")
async def t_sheets(ctx, args):
    ref = _ref(ctx, args)
    async def go():
        return await (await adapter(ctx.session, ctx.tenant_id, "sheets")).read_delivery(ref)
    rows, err = await _connector_call("sheets", go)
    if err:
        return ToolResult(False, error=err[1], connector_down="sheets")
    ids = []
    for r in rows:
        fields = {"po_ref": r.get("po_ref"), "customer": r.get("customer"), "item": r.get("item")}
        for k in ("qty_ordered", "qty_delivered", "qty_pending"):
            if r.get(k) not in (None, ""):
                fields[k] = float(str(r[k]).replace(",", ""))
        content = f"{r}"
        sid = f"row{r.get('row')}:{sha256_text(content)[:10]}"
        ids.append(await _add(ctx, kind="delivery_record", source="sheets", source_id=sid, title=f"Delivery sheet row {r.get('row')}: {r.get('po_ref')}",
                              excerpt=", ".join(f"{k}={v}" for k, v in r.items()), fields=fields, ts=_parse_ts(r.get("updated_at"))))
    if not ids:
        ids.append(await _negative(ctx, "sheets_read_delivery", "sheets", ref, f"no delivery-sheet row for {ref!r}"))
    return ToolResult(True, {"rows": rows}, ids)


@tool("drive_read_doc")
async def t_drive(ctx, args):
    query = args.get("query") or (ctx.case.po_ref or "")
    async def go():
        return await (await adapter(ctx.session, ctx.tenant_id, "drive")).search_docs(query)
    docs, err = await _connector_call("drive", go)
    if err:
        return ToolResult(False, error=err[1], connector_down="drive")
    ids = []
    for d in docs:
        ids.append(await _add(ctx, kind="document", source="drive", source_id=d["id"], title=d.get("name", "doc"), excerpt=(d.get("text") or "")[:2000], fields={"doc_name": d.get("name")}, material=False))
    if not ids:
        ids.append(await _negative(ctx, "drive_read_doc", "drive", query, f"no Drive document matches {query!r}"))
    return ToolResult(True, {"docs": [{"id": d["id"], "name": d.get("name"), "text": (d.get("text") or "")[:1500]} for d in docs]}, ids)


def _invoice_fields(i: dict[str, Any]) -> dict[str, Any]:
    qty = sum(float(li.get("quantity", 0)) for li in i.get("line_items", []) or []) or None
    return {"invoice_id": i.get("invoice_id"), "invoice_number": i.get("invoice_number"), "reference_number": i.get("reference_number"), "po_ref": i.get("reference_number"),
            "customer_id": i.get("customer_id"), "customer": i.get("customer_name"), "total": i.get("total"), "status": i.get("status"), "qty": qty, "notes": i.get("notes", "")}


@tool("zoho_get_salesorders")
async def t_so(ctx, args):
    ref = _ref(ctx, args)
    async def go():
        return await (await adapter(ctx.session, ctx.tenant_id, "zoho")).list_salesorders(ref)
    sos, err = await _connector_call("zoho", go)
    if err:
        return ToolResult(False, error=err[1], connector_down="zoho")
    ids = []
    for so in sos:
        li = (so.get("line_items") or [{}])[0]
        fields = {"po_ref": so.get("reference_number"), "customer_id": so.get("customer_id"), "customer": so.get("customer_name"), "item": li.get("name"),
                  "qty_ordered": li.get("quantity"), "rate": li.get("rate"), "amount": so.get("total"), "salesorder_number": so.get("salesorder_number")}
        ids.append(await _add(ctx, kind="salesorder", source="zoho", source_id=f"so:{so['salesorder_id']}", title=f"Zoho sales order {so.get('salesorder_number')} ({so.get('reference_number')})", excerpt=str({k: so.get(k) for k in ('salesorder_number','reference_number','customer_name','total','status')}), fields=fields, ts=_parse_ts(so.get("date"))))
    if not ids:
        ids.append(await _negative(ctx, "zoho_get_salesorders", "zoho", ref, f"no Zoho sales order with reference {ref!r}"))
    return ToolResult(True, {"salesorders": sos}, ids)


@tool("zoho_get_invoices")
async def t_inv(ctx, args):
    ref = _ref(ctx, args)
    async def go():
        a = await adapter(ctx.session, ctx.tenant_id, "zoho")
        return await a.find_invoices_by_reference(ref) if ref else await a.list_invoices(customer_id=args.get("customer_id"))
    invs, err = await _connector_call("zoho", go)
    if err:
        return ToolResult(False, error=err[1], connector_down="zoho")
    ids = [await _add(ctx, kind="invoice", source="zoho", source_id=f"inv:{i['invoice_id']}", title=f"Zoho invoice {i.get('invoice_number')} ref {i.get('reference_number')}", excerpt=str({k: i.get(k) for k in ('invoice_number','reference_number','customer_name','total','status')}), fields=_invoice_fields(i), ts=_parse_ts(i.get("date"))) for i in invs]
    if not ids:
        ids.append(await _negative(ctx, "zoho_get_invoices", "zoho", ref, f"no Zoho invoice with reference {ref!r}"))
    return ToolResult(True, {"invoices": [{k: i.get(k) for k in ("invoice_id", "invoice_number", "reference_number", "total", "customer_name")} for i in invs], "searched_ref": ref, "found": len(invs)}, ids)


@tool("zoho_get_payments")
async def t_pay(ctx, args):
    ref = _ref(ctx, args)
    async def go():
        return await (await adapter(ctx.session, ctx.tenant_id, "zoho")).list_payments(ref)
    ps, err = await _connector_call("zoho", go)
    if err:
        return ToolResult(False, error=err[1], connector_down="zoho")
    ids = [await _add(ctx, kind="payment", source="zoho", source_id=f"pay:{p['payment_id']}", title=f"Zoho payment {p.get('payment_number')} ₹{p.get('amount')}", excerpt=str(p), fields={"po_ref": p.get("reference_number"), "payment_amount": p.get("amount"), "customer_id": p.get("customer_id")}, ts=_parse_ts(p.get("date"))) for p in ps]
    if not ids:
        ids.append(await _negative(ctx, "zoho_get_payments", "zoho", ref, f"no Zoho customer payment for {ref!r}"))
    return ToolResult(True, {"payments": ps}, ids)


@tool("bank_get_payments")
async def t_bank(ctx, args):
    ref = _ref(ctx, args)
    async def go():
        return await (await adapter(ctx.session, ctx.tenant_id, "bank")).payments(ref, args.get("amount"))
    rows, err = await _connector_call("bank", go)
    if err:
        return ToolResult(False, error=err[1], connector_down="bank")
    ids = [await _add(ctx, kind="bank_txn", source="bank", source_id=r["id"] + ":" + sha256_text(str(r))[:8], title=f"Bank credit ₹{r['credit']} {r.get('date')}", excerpt=r.get("narration", ""), fields={"po_ref": ref, "payment_amount": r["credit"], "reference": r.get("reference")}, ts=_parse_ts(r.get("date"))) for r in rows]
    if not ids:
        ids.append(await _negative(ctx, "bank_get_payments", "bank", ref, f"no bank credit matches {ref!r}"))
    return ToolResult(True, {"credits": rows}, ids)


@tool("evidence_add")
async def t_evidence_add(ctx, args):
    """Agent notes/links. Stored as non-material 'note' nodes: the validator never reads facts from them."""
    note = str(args.get("text") or args.get("excerpt") or "")[:2000]
    links = [x for x in (args.get("links") or args.get("evidence_node_ids") or []) if isinstance(x, str)]
    nid = await _add(ctx, kind="note", source="media", source_id=f"note:{ctx.run_id}:{sha256_text(note)[:10]}", title=str(args.get("title") or "Agent note")[:200], excerpt=note, fields={"agent_note": True, "agent": ctx.agent}, material=False)
    for l in links:
        await cs.add_edge(ctx.session, ctx.case, nid, l, str(args.get("label") or "relates_to")[:60])
    return ToolResult(True, {"node_id": nid}, [nid])


@tool("read_chat_memory")
async def t_chat_memory(ctx, args):
    """What each WhatsApp chat tied to this case has told us: POs, challans and recent statements (as read by the LLM).
    Our own record; never a fact by itself (non-material), but agents use it to decide the next check."""
    from .. import chat_memory

    mems = await chat_memory.chats_for_case(ctx.session, ctx.tenant_id, ctx.case)
    chat = args.get("chat") or args.get("chat_key")
    if chat:
        mems = [m for m in mems if m.chat_id == chat]
        if not mems:  # the chat may not be tied to this case yet (a new message): still the same tenant only
            one = await chat_memory.get(ctx.session, ctx.tenant_id, chat)
            mems = [one] if one is not None else []
    out = [chat_memory.as_json(m) for m in mems]
    ids = []
    for m in mems:
        txt = chat_memory.as_text(m)
        ids.append(await _add(ctx, kind="chat_memory", source="whatsapp", source_id=f"memory:{m.chat_id}:v{ctx.case.evidence_version}",
                              title=f"Chat memory · {m.chat_name or m.chat_id}", excerpt=txt[:4000],
                              fields={"chat_memory": True, "chat_id": m.chat_id, "events": len(m.events or [])}, material=False))
    if not mems:
        ids.append(await _negative(ctx, "read_chat_memory", "whatsapp", ctx.case.po_ref, "no WhatsApp chat has talked about this case yet"))
    return ToolResult(True, {"chats": out}, ids)


# ------------------------------------------------------------------ timeline agent tools (CONTRACT_V3 §1)
@tool("read_case_timeline")
async def t_case_timeline(ctx, args):
    """Every message of a case in time order with status (active|edited|deleted|duplicate|superseded), old versions,
    read_by, challan number and qty as read. Text inside is the sender's words (untrusted data)."""
    from .. import timeline
    from ..untrusted import wrap_untrusted

    case = await timeline.find_case(ctx.session, ctx.tenant_id, args.get("case_ref")) if args.get("case_ref") else ctx.case
    if case is None:
        return ToolResult(False, error=f"no case {args.get('case_ref')!r} for this business")
    nodes = await timeline.case_timeline(ctx.session, case)
    for n in nodes:
        n["text"] = wrap_untrusted(n["text"], n["source"], n["node_id"], preamble=False) if n["text"] else ""
        n["versions"] = [{"text": wrap_untrusted(str(v.get("text") or ""), n["source"], f"{n['node_id']}:v", preamble=False), "at": v.get("at")} for v in n["versions"]]
    return ToolResult(True, {"case_ref": case.case_number, "po_ref": case.po_ref, "customer": case.customer, "state": case.state, "nodes": nodes},
                      [n["node_id"] for n in nodes])


@tool("search_cases")
async def t_search_cases(ctx, args):
    """This business's cases by PO, customer or free text (tenant-scoped, newest first, max 10)."""
    from sqlalchemy import select

    q = str(args.get("query") or "").strip()
    po = args.get("po_ref") or (q if q and normalize_ref(q) and any(ch.isdigit() for ch in q) else None)
    cust = str(args.get("customer") or (q if q and not po else "")).strip().lower()
    rows = (await ctx.session.execute(select(Case).where(Case.tenant_id == ctx.tenant_id).order_by(Case.updated_at.desc()).limit(300))).scalars().all()
    out = []
    for c in rows:
        if po and not refs_match(c.po_ref, po):
            continue
        if cust and cust not in (c.customer or "").lower() and cust not in (c.title or "").lower():
            continue
        fx = c.facts or {}
        out.append({"case_ref": c.case_number, "po_ref": c.po_ref, "customer": c.customer, "state": c.state,
                    "order_qty": fx.get("order_qty"), "delivered_qty": fx.get("delivered_qty"), "updated_at": c.updated_at.isoformat() if c.updated_at else None})
        if len(out) >= 10:
            break
    return ToolResult(True, {"cases": out, "searched": {"po_ref": po, "customer": cust or None}})


@tool("write_chat_memory")
async def t_write_memory(ctx, args):
    """Timeline agent's own notes on a chat: active_po, open_questions, pending, summary (<= 600 chars)."""
    from .. import chat_memory

    chat = args.get("chat_key") or args.get("chat")
    if not chat:
        return ToolResult(False, error="chat_key is required")
    st = await chat_memory.write_state(ctx.session, ctx.tenant_id, str(chat), args.get("patch") if isinstance(args.get("patch"), dict) else {})
    if st is None:
        return ToolResult(False, error="unknown chat for this business")
    return ToolResult(True, {"chat_key": chat, "state": st})


@tool("propose_timeline")
async def t_propose_timeline(ctx, args):
    """Check a TimelineDecision with the code verifier (shape + ids + grounding + sum + link + confidence). Stores nothing:
    the run's final answer is what counts, and it is verified again."""
    from pydantic import ValidationError

    from .. import timeline
    from ..schemas import TimelineDecision

    try:
        d = TimelineDecision.model_validate(args.get("decision") or {}).model_dump()
    except ValidationError as e:
        return ToolResult(True, {"valid_shape": False, "verified": False, "failed_checks": [f"shape: {str(e)[:500]}"]})
    case = await timeline.find_case(ctx.session, ctx.tenant_id, args.get("case_ref")) if args.get("case_ref") else ctx.case
    text = ""
    if ctx.run_id:
        from ..models import AgentRun

        run = await ctx.session.get(AgentRun, ctx.run_id)
        text = str(((run.input or {}).get("trigger") or {}).get("text") or "") if run else ""
    ok, failed = await timeline.verify_decision(ctx.session, case or ctx.case, d, text)
    return ToolResult(True, {"valid_shape": True, "verified": ok, "failed_checks": failed})


# ------------------------------------------------------------------ investigation tools
@tool("search_alt_ids")
async def t_alt(ctx, args):
    ref = _ref(ctx, args)
    facts = await cs.compute_facts(ctx.session, ctx.case)
    customer_id = args.get("customer_id") or facts.customer_id
    async def go():
        a = await adapter(ctx.session, ctx.tenant_id, "zoho")
        found: dict[str, dict] = {}
        for v in ref_variants(ref)[:12] if ref else []:
            for i in await a.list_invoices(search=v):
                found[i["invoice_id"]] = i
        if customer_id:
            for i in await a.list_invoices(customer_id=customer_id):
                found[i["invoice_id"]] = i
        return list(found.values())
    invs, err = await _connector_call("zoho", go)
    if err:
        return ToolResult(False, error=err[1], connector_down="zoho")
    results, ids = [], []
    for i in invs:
        match = refs_match(i.get("reference_number"), ref) or text_mentions_ref(i.get("notes", ""), ref or "")
        amount_match = facts.order_amount is not None and abs(float(i.get("total") or 0) - float(facts.order_amount)) < 0.01
        verdict = "matches_reference" if match else ("same_amount_different_reference" if amount_match else "ruled_out_different_reference")
        f = _invoice_fields(i) | {"alt_search_verdict": verdict}
        if match:
            f["po_ref"] = ref  # the invoice covers this order even though it is filed under another reference
            f["matched_via"] = "alternate_reference"
        nid = await _add(ctx, kind="invoice", source="zoho", source_id=f"inv:{i['invoice_id']}", title=f"Alt-ID check: {i.get('invoice_number')} ref {i.get('reference_number')} → {verdict}", excerpt=str({k: i.get(k) for k in ('invoice_number','reference_number','customer_name','total')}), fields=f, ts=_parse_ts(i.get("date")), material=match)
        ids.append(nid)
        results.append({"invoice_number": i.get("invoice_number"), "reference_number": i.get("reference_number"), "total": i.get("total"), "verdict": verdict, "node_id": nid})
    if not any(r["verdict"] == "matches_reference" for r in results):
        ids.append(await _negative(ctx, "search_alt_ids", "zoho", ref, f"no invoice under any alternate reference of {ref!r} ({len(results)} candidate(s) ruled out)", variants=ref_variants(ref)[:12] if ref else []))
    return ToolResult(True, {"variants_tried": ref_variants(ref)[:12] if ref else [], "candidates": results, "matching": [r for r in results if r["verdict"] == "matches_reference"]}, ids)


@tool("search_credit_notes")
async def t_cn(ctx, args):
    facts = await cs.compute_facts(ctx.session, ctx.case)
    async def go():
        a = await adapter(ctx.session, ctx.tenant_id, "zoho")
        return await a.list_creditnotes(args.get("ref") or None)
    cns, err = await _connector_call("zoho", go)
    if err:
        return ToolResult(False, error=err[1], connector_down="zoho")
    out, ids = [], []
    for c in cns:
        relevant = (facts.customer_id and c.get("customer_id") == facts.customer_id) or refs_match(c.get("reference_number"), ctx.case.po_ref)
        verdict = "relevant" if relevant else "ruled_out_other_customer"
        nid = await _add(ctx, kind="credit_note", source="zoho", source_id=f"cn:{c['creditnote_id']}", title=f"Credit note {c.get('creditnote_number')} ({c.get('customer_name')}) → {verdict}", excerpt=str(c), fields={"creditnote_number": c.get("creditnote_number"), "customer_id": c.get("customer_id") if relevant else None, "total": c.get("total"), "verdict": verdict, "po_ref": c.get("reference_number")}, material=bool(relevant))
        ids.append(nid)
        out.append({"creditnote_number": c.get("creditnote_number"), "customer_name": c.get("customer_name"), "verdict": verdict, "node_id": nid})
    if not any(x["verdict"] == "relevant" for x in out):
        ids.append(await _negative(ctx, "search_credit_notes", "zoho", ctx.case.po_ref, f"no credit note relates to {ctx.case.po_ref!r} or this customer ({len(out)} ruled out)"))
    return ToolResult(True, {"credit_notes": out, "relevant": [x for x in out if x["verdict"] == "relevant"]}, ids)


def _dec(v: Any) -> Any:
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, dict):
        return {k: _dec(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_dec(x) for x in v]
    return v


@tool("compute_billable")
async def t_billable(ctx, args):
    f = await cs.compute_facts(ctx.session, ctx.case)
    if not f.billable:
        missing = [k for k, v in (("order_qty", f.order_qty), ("delivered_qty", f.delivered_qty), ("rate", f.rate)) if v is None]
        return ToolResult(True, {"billable": None, "missing_inputs": missing, "conflicts": f.conflicts})
    return ToolResult(True, {"billable": _dec(f.billable), "order_qty": _dec(f.order_qty), "delivered_qty": _dec(f.delivered_qty), "rate": _dec(f.rate),
                             "delivery_sources": f.delivery_sources, "conflicts": f.conflicts, "duplicates": _dec(f.duplicates), "note": "validator facts (Decimal); these override any agent arithmetic"},
                      f.stage_nodes["order"][:2] + f.stage_nodes["delivery"][-3:])


@tool("get_billing_rules")
async def t_rules(ctx, args):
    f = await cs.compute_facts(ctx.session, ctx.case)
    rule = await cs.billing_rule_for(ctx.session, ctx.tenant_id, args.get("customer_id") or f.customer_id)
    policy_docs = []
    try:
        docs = await (await adapter(ctx.session, ctx.tenant_id, "drive")).search_docs("billing policy")
        policy_docs = [{"name": d.get("name"), "text": (d.get("text") or "")[:800]} for d in docs[:2]]
    except ConnectorError:
        pass
    return ToolResult(True, {"rule": rule, "policy_docs": policy_docs, "source": "tenant billing configuration (code-owned)"})


# ------------------------------------------------------------------ resolution tools
@tool("draft_action")
async def t_draft(ctx, args):
    f = await cs.compute_facts(ctx.session, ctx.case)
    kind = args.get("type")
    b = f.billable or {}
    claims = []
    if f.stage_nodes["order"]:
        claims.append({"text": f"Order {ctx.case.po_ref}: {_dec(f.order_qty)} units of {f.item} at ₹{_dec(f.rate)} (₹{_dec(f.order_amount)})", "evidence_node_ids": f.stage_nodes["order"][:3]})
    if f.delivery_sources:
        claims.append({"text": f"Delivered quantity {_dec(f.delivered_qty)} per " + ", ".join(f"{d['source']}={d['qty']}{' (correction)' if d['correction'] else ''}" for d in f.delivery_sources), "evidence_node_ids": [d["node_id"] for d in f.delivery_sources]})
    inv_checked = [n for n in f.stage_nodes["invoice"]]
    from sqlalchemy import select
    from ..models import EvidenceNode

    from sqlalchemy import and_, or_

    ruled = (await ctx.session.execute(select(EvidenceNode.id).where(
        EvidenceNode.case_id == ctx.case.id, EvidenceNode.quarantined.is_(False),
        or_(EvidenceNode.kind.in_(("invoice", "credit_note")), and_(EvidenceNode.kind == "search_result", EvidenceNode.source == "zoho"))))).scalars().all()
    if not f.duplicates and ruled:
        claims.append({"text": f"No existing invoice for {ctx.case.po_ref}; alternate-reference and credit-note checks ruled out {len(ruled)} candidate record(s)", "evidence_node_ids": list(ruled)[:5]})
    if kind is None:
        inv_total = sum((d["total"] for d in f.duplicates), Decimal(0))
        if len(f.duplicates) == 1 and Decimal(0) < f.paid_amount < inv_total:
            kind = "send_reminder"
        elif f.duplicates and not (b and b.get("top_up_ok") and Decimal(str(b.get("amount_when_due", b.get("amount", 0)) or 0)) > 0):
            kind = "none"
        elif b and Decimal(str(b.get("amount", 0))) > 0:
            kind = "create_invoice"
        else:
            kind = "none"
    action: dict[str, Any] = {"type": kind}
    if kind == "create_invoice":
        action |= {"customer_id": f.customer_id, "customer_name": f.customer_name, "reference": ctx.case.po_ref,
                   "line_items": [{"item": f.item or "Item", "qty": _dec(b.get("billable_qty")), "rate": _dec(b.get("rate"))}], "amount": _dec(b.get("amount"))}
        if f.duplicates and b.get("top_up_ok"):
            action["top_up_of"] = sorted(d.get("invoice_number") or "" for d in f.duplicates)
            claims.append({"text": f"{_dec(b.get('invoiced_qty'))} units already billed on " + ", ".join(action["top_up_of"]) + f"; this invoice covers only the extra {_dec(b.get('billable_qty'))}",
                           "evidence_node_ids": f.stage_nodes["invoice"][:3]})
    elif kind == "send_reminder":
        due = sum((d["total"] for d in f.duplicates), Decimal(0)) - f.paid_amount
        action |= {"customer_id": f.customer_id, "customer_name": f.customer_name, "reference": ctx.case.po_ref, "line_items": [], "amount": _dec(due), "channel": args.get("channel") or "whatsapp",
                   "message": f"Hello from accounts: for {ctx.case.po_ref}, ₹{_dec(due)} remains outstanding against invoice(s) " + ", ".join(d['invoice_number'] or '' for d in f.duplicates) + ". Kindly arrange payment or let us know if already paid."}
    uncertainty = []
    for c in f.conflicts:
        uncertainty.append(f"conflict on {c['field']}: {c['values']}")
    if any(d["correction"] for d in f.delivery_sources):
        uncertainty.append("delivered quantity relies on an explicit correction message that superseded earlier evidence")
    if f.order_qty is not None and f.delivered_qty is not None and f.delivered_qty < f.order_qty:
        uncertainty.append(f"{_dec(f.order_qty - f.delivered_qty)} units still pending delivery; bill only delivered quantity")
    return ToolResult(True, {"action": action, "claims": claims, "uncertainty": uncertainty}, [n for c in claims for n in c["evidence_node_ids"]])


@tool("risk_score")
async def t_risk(ctx, args):
    f = await cs.compute_facts(ctx.session, ctx.case)
    amount = float((args.get("action") or {}).get("amount") or (f.billable or {}).get("amount") or 0)
    score = 0
    reasons = []
    if amount > 100000:
        score += 2
        reasons.append("amount above ₹1,00,000 (two approvers)")
    elif amount > 25000:
        score += 1
        reasons.append("amount above ₹25,000")
    if f.conflicts:
        score += 2
        reasons.append("conflicting evidence")
    if f.quarantined_node_ids:
        score += 1
        reasons.append("case has quarantined (possible injection) content")
    if any(d["correction"] for d in f.delivery_sources):
        score += 1
        reasons.append("quantity based on a correction message")
    risk = "high" if score >= 3 else ("medium" if score >= 1 else "low")
    return ToolResult(True, {"risk": risk, "score": score, "reasons": reasons})


# ------------------------------------------------------------------ dispatch
async def dispatch(ctx: ToolCtx, name: str, args: dict[str, Any]) -> ToolResult:
    """Allow-list re-check, execution and tool_calls logging (single entry point for HTTP and builtin runner)."""
    t0 = time.perf_counter()
    allowed = ctx.agent in ALLOW_LIST and name in ALLOW_LIST[ctx.agent] and name in TOOLS
    row = ToolCall(tenant_id=ctx.tenant_id, case_id=ctx.case.id, run_id=ctx.run_id, agent=ctx.agent, tool=name, args=args or {}, allowed=allowed, correlation_id=ctx.correlation_id)
    if not allowed:
        row.ok = False
        row.error = "tool not in allow-list for agent"
        ctx.session.add(row)
        await append_audit(ctx.session, ctx.tenant_id, "tool.denied", f"agent:{ctx.agent}", {"tool": name, "run_id": ctx.run_id}, ctx.case.id, ctx.correlation_id)
        cs.guardrail_event(ctx.session, ctx.tenant_id, ctx.case.id, "role_block", {"agent": ctx.agent, "tool": name, "reason": "tool not allowed for agent"})
        await ctx.session.flush()
        raise ToolDenied(f"agent '{ctx.agent}' may not call '{name}'")
    try:
        res = await TOOLS[name](ctx, args or {})
    except ConnectorError as e:
        res = ToolResult(False, error=str(e), connector_down=e.connector)
    row.ok = res.ok
    row.error = res.error
    row.latency_ms = int((time.perf_counter() - t0) * 1000)
    row.result_summary = {"evidence_node_ids": res.evidence_node_ids[:20], "connector_down": res.connector_down}
    ctx.session.add(row)
    await ctx.session.flush()
    return res
