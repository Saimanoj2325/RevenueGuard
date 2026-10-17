"""BUILT-IN PYTHON FALLBACK AGENT RUNNER (label: builtin-python-fallback).

Used only when the DeepSeek Harness is unreachable in DEMO_MODE (or AGENT_RUNNER=builtin). These agents are
deterministic: they call the SAME /tools implementations through the same allow-list + logging path and emit
the same agent events, so the API alone can play the full demo. Real reasoning runs in services/harness.
Exception: the timeline agent here is a real LLM tool-calling loop (app/timeline.py); only demo mode with no model
key uses its labelled static stand-in.
"""
from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from ..observability import get_logger
from ..schemas import AGENT_SCHEMAS
from .agents import AgentOutcome, BuiltinCtx

log = get_logger("builtin_agents")


def _ans(laya: dict[str, Any], qid: str) -> dict[str, Any]:
    return ((laya or {}).get("answers") or {}).get(qid) or {}


def _p_true(a: dict[str, Any], default: float = 0.5) -> float:
    probs = a.get("probs") or {}
    if "true" in probs:
        return float(probs["true"])
    v = a.get("value")
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    return default


async def triage(ctx: BuiltinCtx, mode: str) -> dict[str, Any]:
    laya_res = (await ctx.call_tool("laya_decide", {"question_set": "triage"})).get("data") or {}
    ext = (await ctx.call_tool("extract_fields", {})).get("data") or {}
    fields = ext.get("fields") or {}
    meta = ext.get("meta") or {}
    if meta:
        await ctx.emit("model_call", {"task": "extract_fields", "provider": meta.get("provider"), "model": meta.get("model"), "mock": meta.get("mock"), "cost_inr": meta.get("cost_inr", 0)})
    case = ctx.snapshot["case"]
    po = case.get("po_ref") or fields.get("po_ref")
    await ctx.call_tool("case_attach_or_open", {"po": po, "customer": fields.get("customer")})
    ex = _ans(laya_res, "exception_type").get("value") or "none"
    sev = _ans(laya_res, "severity").get("value") or "medium"
    genuine = _p_true(_ans(laya_res, "genuine"), 0.5)
    review = _p_true(_ans(laya_res, "needs_review"), 0.3)
    amount = fields.get("amount") or case.get("amount")
    qty = fields.get("qty_ordered") or fields.get("qty_delivered")
    return {
        "exception_type": ex,
        "severity": sev,
        "genuine_prob": round(genuine, 4),
        "needs_review_prob": round(review, 4),
        "laya": laya_res,
        "refs": {"po": po, "customer": fields.get("customer") or case.get("customer"), "amount": amount, "qty": qty},
        "summary": f"{ex.replace('_', ' ')} suspected for {po or 'unknown reference'}"
        + (f" ({fields.get('customer')})" if fields.get("customer") else "")
        + f"; severity {sev}; Laya {'heuristic fallback' if laya_res.get('fallback') else laya_res.get('model', 'laya')}.",
    }


async def evidence(ctx: BuiltinCtx, mode: str) -> dict[str, Any]:
    ref = ctx.snapshot["case"].get("po_ref")
    added: list[str] = []
    plan = [
        ("gmail_search", {"query": ref}), ("whatsapp_search", {"ref": ref}), ("sheets_read_delivery", {"ref": ref}),
        ("zoho_get_salesorders", {"ref": ref}), ("zoho_get_invoices", {"ref": ref}), ("zoho_get_payments", {"ref": ref}), ("bank_get_payments", {"ref": ref}),
    ]
    down = []
    for name, args in plan:
        if ctx.steps_left <= 0:
            break
        r = await ctx.call_tool(name, args)
        added += r.get("evidence_node_ids") or []
        if r.get("connector_down"):
            down.append(r["connector_down"])
    snap = await ctx.refresh()
    missing = [t["stage"] for t in snap["timeline"] if t["status"] == "missing"]
    return {
        "nodes_added": list(dict.fromkeys(added)),
        "missing_links": missing,
        "summary": f"Collected {len(set(added))} source-linked records for {ref}; missing: {', '.join(missing) or 'none'}" + (f"; unavailable connectors: {', '.join(down)}" if down else ""),
    }


def _new(ids: list[str], seen: set[str]) -> list[str]:
    fresh = [i for i in ids if i not in seen]
    seen.update(ids)
    return fresh


async def investigation(ctx: BuiltinCtx, mode: str) -> dict[str, Any]:
    snap = ctx.snapshot
    seen = {e["id"] for e in snap["evidence"]}
    steps: list[dict[str, Any]] = []
    findings: list[str] = []
    ref = snap["case"].get("po_ref")

    async def step(tool: str, why: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        r = await ctx.call_tool(tool, args or {})
        fresh = _new(r.get("evidence_node_ids") or [], seen)
        steps.append({"tool": tool, "why": why, "added_evidence": bool(fresh), "evidence_node_ids": fresh})
        return r

    if mode == "fixed":
        # fixed baseline: the same 8 checks in the same order on every case, regardless of the evidence gap
        for tool, args in [("gmail_search", {"query": ref}), ("whatsapp_search", {"ref": ref}), ("sheets_read_delivery", {"ref": ref}), ("zoho_get_invoices", {"ref": ref}),
                           ("zoho_get_payments", {"ref": ref}), ("search_alt_ids", {"ref": ref}), ("get_billing_rules", {}), ("compute_billable", {})]:
            if ctx.steps_left <= 0:
                snap = await ctx.refresh()
                return {"steps": steps, "findings": findings + ["fixed sequence exhausted step budget"], "stop_reason": "budget", "conflict": bool(snap["facts"]["conflicts"])}
            await step(tool, "fixed sequence", args)
        snap = await ctx.refresh()
        conflict = bool(snap["facts"]["conflicts"])
        return {"steps": steps, "findings": findings, "stop_reason": "conflict" if conflict else "gap_closed", "conflict": conflict}

    # ---------------- adaptive: next check depends on the current evidence gap
    for _ in range(6):
        if ctx.steps_left <= 0:
            return {"steps": steps, "findings": findings, "stop_reason": "budget", "conflict": bool(snap["facts"]["conflicts"])}
        facts, tl = snap["facts"], {t["stage"]: t["status"] for t in snap["timeline"]}
        conflicts = {c["field"]: c for c in facts["conflicts"]}
        if "delivered_qty" in conflicts and not any(s["tool"] == "whatsapp_search" for s in steps):
            await step("read_chat_memory", "delivery quantities disagree; check what the chat already told us about this PO (corrections, extra deliveries, challans)")
            r = await step("whatsapp_search", "delivery quantities disagree; look for a later correction from operations", {"q": "correction"})
            await step("sheets_read_delivery", "re-read delivery sheet to confirm the corrected quantity", {"ref": ref})
        elif "delivered_qty" in conflicts:
            findings.append(f"delivery quantity conflict persists: {conflicts['delivered_qty']['values']}")
            return {"steps": steps, "findings": findings, "stop_reason": "conflict", "conflict": True}
        elif tl.get("delivery") == "missing" and not any(s["tool"] == "sheets_read_delivery" for s in steps):
            await step("sheets_read_delivery", "no delivery evidence yet; check operations sheet", {"ref": ref})
            await step("whatsapp_search", "look for challan or dispatch message", {"ref": ref})
        elif tl.get("invoice") == "missing" and not any(s["tool"] == "search_alt_ids" for s in steps):
            r = await step("search_alt_ids", "first search found no invoice; check alternate spellings / customer / amount before concluding it is missing", {"ref": ref})
            data = r.get("data") or {}
            for c in data.get("candidates", []):
                findings.append(f"{c['invoice_number']} (ref {c['reference_number']}, ₹{c['total']}): {c['verdict'].replace('_', ' ')}")
            if data.get("matching"):
                findings.append("an invoice already exists under an alternate reference")
                return {"steps": steps, "findings": findings, "stop_reason": "gap_closed", "conflict": False}
        elif tl.get("invoice") == "missing" and not any(s["tool"] == "search_credit_notes" for s in steps):
            r = await step("search_credit_notes", "rule out a credit note / adjustment that explains the missing invoice", {})
            for c in (r.get("data") or {}).get("credit_notes", []):
                findings.append(f"credit note {c['creditnote_number']} ({c['customer_name']}): {c['verdict'].replace('_', ' ')}")
        elif not any(s["tool"] == "get_billing_rules" for s in steps):
            r = await step("get_billing_rules", "confirm which quantity the billing policy allows to be invoiced", {})
            rule = (r.get("data") or {}).get("rule") or {}
            findings.append(f"billing rule: {rule.get('mode', 'on_delivery')}, partial allowed={rule.get('allow_partial', True)}, delay {rule.get('delay_days', 0)}d")
        elif tl.get("payment") in ("partial",) and not any(s["tool"] == "bank_get_payments" for s in steps):
            await step("bank_get_payments", "invoice exists with partial payment; confirm receipts in bank statement", {"ref": ref})
        elif not any(s["tool"] == "compute_billable" for s in steps):
            r = await step("compute_billable", "exact billable amount from validator facts", {})
            b = (r.get("data") or {}).get("billable")
            if b:
                findings.append(f"billable {b['billable_qty']} × ₹{b['rate']} = ₹{b['amount']} ({b['rule']})" + (f"; not due until {b['due_at']}" if b.get("not_due") else ""))
        else:
            break
        snap = await ctx.refresh()
    conflict = bool(snap["facts"]["conflicts"])
    added_any = any(s["added_evidence"] for s in steps)
    return {"steps": steps, "findings": findings, "stop_reason": "conflict" if conflict else ("gap_closed" if snap["facts"].get("billable") or added_any else "no_new_evidence"), "conflict": conflict}


async def resolution(ctx: BuiltinCtx, mode: str) -> dict[str, Any]:
    await ctx.call_tool("compute_billable", {})
    d = (await ctx.call_tool("draft_action", {})).get("data") or {}
    action = d.get("action") or {"type": "none"}
    r = (await ctx.call_tool("risk_score", {"action": action})).get("data") or {}
    return {"action": action, "claims": d.get("claims") or [], "uncertainty": d.get("uncertainty") or [], "risk": r.get("risk", "medium")}


async def timeline(ctx: BuiltinCtx, mode: str) -> dict[str, Any]:
    """Timeline agent: a real LLM tool-calling loop (app/timeline.py). Demo mode with no model key uses the labelled stand-in."""
    from ..timeline import agent_loop

    return await agent_loop(ctx)


AGENTS = {"triage": triage, "evidence": evidence, "investigation": investigation, "resolution": resolution, "timeline": timeline}


async def run_builtin(run_id, case_id, tenant_id, corr, agent, snap, budget, garbage: bool, mode: str) -> AgentOutcome:
    ctx = BuiltinCtx(run_id, case_id, tenant_id, corr, agent, snap, budget)
    schema = AGENT_SCHEMAS[agent]
    last_err = ""
    for attempt in range(3):  # initial + 2 retries (CONTRACT: retries <= 2)
        try:
            out = {"answer": "Sure! The case looks fine, I closed it."} if garbage else await AGENTS[agent](ctx, mode)
            schema.model_validate(out)
            await ctx.emit("step_finished", {"attempt": attempt + 1, "steps": ctx.steps})
            await ctx.emit("run_finished", {"output": out, "runner": "builtin-python-fallback"})
            return AgentOutcome(True, run_id, agent, out)
        except ValidationError as e:
            last_err = str(e)[:300]
            await ctx.emit("model_call", {"attempt": attempt + 1, "result": "invalid_output", "error": last_err})
        except Exception as e:  # noqa: BLE001
            log.exception("builtin.agent_error", agent=agent)
            await ctx.emit("run_failed", {"reason": f"error: {type(e).__name__}: {str(e)[:200]}"})
            return AgentOutcome(False, run_id, agent, error=str(e))
    await ctx.emit("run_failed", {"reason": "invalid_output", "detail": last_err})
    return AgentOutcome(False, run_id, agent, error="invalid_output")
