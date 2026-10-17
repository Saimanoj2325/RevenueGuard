"""Scripted fake LLM for the timeline agent tests. It plays the model's side of the real tool-calling loop:
asks for read_case_timeline (and read_chat_memory), then answers with a TimelineDecision from a script.
Everything around it (tools, allow-list, events, verifier, facts) is the real code."""
from __future__ import annotations

import json
import re
from typing import Any, Callable

from app.extraction import regex_extract

Decider = Callable[[dict[str, Any], list[dict[str, Any]], dict[str, Any]], dict[str, Any]]


def body_of(user: str) -> str:
    m = re.findall(r"<untrusted_source[^>]*>\n(.*?)\n</untrusted_source>", user, re.S)
    return m[-1] if m else user


def fake_reader(text: str) -> dict[str, Any]:
    """Stands in for the LLM reader (extract_fields)."""
    if re.search(r"(?i)\baur\s+40\s+aa\s+gaye\b", text):
        return {"doc_type": "delivery", "qty_delivered": 40, "is_incremental": True, "language": "hinglish", "confidence": 0.9, "meaning": "40 more arrived"}
    return {**regex_extract(text), "confidence": 0.9}


def install(monkeypatch, decider: Decider, *, live: bool = True, down: bool = False) -> dict[str, Any]:
    """demo_mode off, fake reader + fake tool-calling model. Returns a dict that records what the model saw."""
    from app.config import get_settings
    from app.llm import router as r
    from app.llm import tool_loop

    seen: dict[str, Any] = {"turns": 0, "tools": [], "users": []}
    monkeypatch.setattr(get_settings(), "demo_mode", not live)
    real = r.get_llm().complete_structured

    async def fake_structured(task, messages, schema, mock_fn, **kw):
        if task != "extract_fields":
            return await real(task, messages, schema, mock_fn, **kw)
        return r.LLMResult(data=fake_reader(body_of(messages[-1]["content"])), provider="nim", model="fake-reader", latency_ms=1, cost_inr=0, tokens=5, attempts=[], mock=False)

    async def fake_turn(task, messages, tools, **kw):
        if down:
            raise r.LLMUnavailable("all providers down (test)")
        seen["turns"] += 1
        user = messages[1]["content"]
        trig = json.loads(re.search(r"NEW EVENT: (\{.*\})", user).group(1))
        trig["text"] = body_of(user) if "NEW MESSAGE TEXT" in user else ""
        results = {}
        for m in messages:
            if m.get("role") == "tool":
                d = json.loads(m["content"])
                results[d["tool"]] = (d["result"] or {}).get("data") or {}
        if "read_case_timeline" not in results:
            seen["tools"].append("read_case_timeline")
            return tool_loop.TurnResult(content="", tool_calls=[tool_loop.ToolCallOut("c1", "read_case_timeline", {"why": "see every message in order"})], provider="nim", model="fake")
        if trig.get("chat_key") and "read_chat_memory" not in results:
            seen["tools"].append("read_chat_memory")
            return tool_loop.TurnResult(content="", tool_calls=[tool_loop.ToolCallOut("c2", "read_chat_memory", {"chat_key": trig["chat_key"], "why": "what this chat talks about"})],
                                        provider="nim", model="fake")
        seen["users"].append(user)
        d = decider(trig, results["read_case_timeline"].get("nodes") or [], results.get("read_chat_memory") or {})
        return tool_loop.TurnResult(content=json.dumps(d), provider="nim", model="fake")

    monkeypatch.setattr(r.get_llm(), "complete_structured", fake_structured)
    monkeypatch.setattr(tool_loop, "live_available", lambda: True)
    monkeypatch.setattr(tool_loop, "chat_with_tools", fake_turn)
    return seen


def _qty(n: dict[str, Any]) -> float | None:
    if n.get("qty_kind") == "delivered":
        return float(n["qty"])
    if n.get("qty_kind") == "ordered":
        return None
    q = regex_extract(body_of(n.get("text") or "")).get("qty_delivered")
    return float(q) if q is not None else None


def smart(trig: dict[str, Any], nodes: list[dict[str, Any]], memory: dict[str, Any]) -> dict[str, Any]:
    """A competent model's reading, scripted: corrections replace, same challan once, resends/deletes never count,
    several open POs in the chat and no PO in the message -> ask which PO."""
    case_ref = None
    pos = {c.get("po") for ch in (memory.get("chats") or []) for c in (ch.get("cases") or []) if c.get("po")}
    if trig.get("kind") == "message" and len(pos) > 1 and not re.search(r"(?i)\bPO[-\s]?\d+", trig.get("text") or ""):
        return {"link": {"action": "ask_which_po", "case_ref": None, "po_ref": None, "why": f"this chat talks about {', '.join(sorted(pos))} and the message names none"},
                "meaning": "delivery", "delivered": {"total": None, "events": []}, "memory_patch": {"open_questions": ["Which PO are the 40 for?"]},
                "confidence": 0.9, "explanation_for_owner": "This chat has two open orders, so we asked which PO it is for."}
    events, challans = [], {}
    for n in nodes:
        q = _qty(n)
        if q is None:
            continue
        if n["status"] == "deleted":
            events.append({"node_id": n["node_id"], "qty": q, "role": "ignored", "why": "deleted by the sender"})
            continue
        if n["status"] == "duplicate":
            events.append({"node_id": n["node_id"], "qty": q, "role": f"duplicate_of:{n['duplicate_of']}", "why": "same photo sent again"})
            continue
        if n.get("is_correction"):
            for e in events:
                if e["role"] == "counts":
                    e["role"], e["why"] = "replaced", "a later correction gives the total"
        ch = n.get("challan_number")
        if ch and ch in challans:
            challans[ch]["role"] = "replaced"
        e = {"node_id": n["node_id"], "qty": q, "role": "counts", "why": "correction: new total" if n.get("is_correction") else ("extra delivery" if n.get("is_incremental") else "a delivery")}
        if ch:
            challans[ch] = e
        events.append(e)
    counts = [e for e in events if e["role"] == "counts"]
    total = sum(e["qty"] for e in counts) if counts else None
    t = trig.get("text") or ""
    meaning = {"resend": "duplicate", "edit": "edit", "delete": "retraction"}.get(trig.get("kind"))
    if meaning is None:
        tn = next((n for n in nodes if n["node_id"] == trig.get("node_id")), {})
        meaning = "correction" if tn.get("is_correction") else ("extra_delivery" if tn.get("is_incremental") else ("delivery" if _qty(tn) is not None else ("order" if "Purchase Order" in t else "noise")))
    return {"link": {"action": "existing_case", "case_ref": case_ref, "po_ref": None, "why": "same PO and chat"}, "meaning": meaning,
            "delivered": {"total": total, "events": events}, "memory_patch": {"summary": f"delivered so far {total}" if total is not None else "no delivery yet"},
            "confidence": 0.92, "explanation_for_owner": (f"Delivered so far: {total:g}." if total is not None else "No delivery yet.")}
