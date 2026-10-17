"""Timeline agent eval: 10 messy WhatsApp timelines with hand-labelled answers.

    python -m eval.timeline_eval            # from the repo root
    NVIDIA_API_KEY=... python -m eval.timeline_eval   # also runs the REAL model

Two things are measured:
  * oracle  - the old static rules (validator.derive_facts over the reader's fields, minus deleted/duplicate messages,
              plus the intake "several POs -> ask" rule). Static rules are kept only as this oracle and the demo stand-in.
  * model   - the real timeline agent: the same system prompt and tool-calling loop as production (app/timeline.py +
              app/llm/tool_loop.py); tool results come from the timeline below instead of the database. Its answer then
              goes through the real code verifier (app/timeline_verify.py). Skipped when NVIDIA_API_KEY is not set.
A case is correct when total (or link action) matches, meaning is one of the accepted meanings and the verifier passes.
Writes eval/results/timeline_latest.json.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "services" / "api"))
os.environ.setdefault("DEMO_MODE", "false")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:////tmp/rg-timeline-eval.db")
os.environ.setdefault("LOG_LEVEL", "ERROR")

T0 = datetime(2026, 10, 14, 9, tzinfo=timezone.utc)
CHAT = "ops-chat"


def n(i: str, mins: int, text: str, status: str = "active", **fields: Any) -> dict[str, Any]:
    return {"node_id": i, "at": (T0 + timedelta(minutes=mins)).isoformat(), "text": text, "status": status, "fields": fields,
            "kind": "chat_message", "source": "whatsapp"}


ORDER = n("o1", 0, "Purchase Order PO-184: 100 x Model X at Rs 1000", qty_ordered=100, rate=1000, po_ref="PO-184")
CASES: list[dict[str, Any]] = [
    {"name": "two different challans add up", "nodes": [ORDER, n("a", 60, "Challan CH-101: 60 delivered", qty_delivered=60, challan_number="CH-101"),
                                                       n("b", 120, "Challan CH-102: 40 delivered", qty_delivered=40, challan_number="CH-102")],
     "trigger": "b", "expect": {"total": 100, "meaning": {"delivery"}}},
    {"name": "correction replaces the earlier count", "nodes": [ORDER, n("a", 60, "60 delivered today", qty_delivered=60),
                                                                n("b", 90, "Correction: 100, not 60", qty_delivered=100, is_correction=True)],
     "trigger": "b", "expect": {"total": 100, "meaning": {"correction"}}},
    {"name": "Hinglish extra delivery", "nodes": [ORDER, n("a", 60, "Challan CH-7: 60 delivered", qty_delivered=60, challan_number="CH-7"),
                                                  n("b", 200, "aur 40 aa gaye", qty_delivered=40, is_incremental=True)],
     "trigger": "b", "expect": {"total": 100, "meaning": {"extra_delivery"}}},
    {"name": "same photo resent (duplicate status)", "nodes": [ORDER, n("a", 60, "CH-9 60 delivered (photo)", qty_delivered=60, challan_number="CH-9"),
                                                               n("b", 65, "CH-9 60 delivered (photo)", status="duplicate", duplicate_of="a", qty_delivered=60, challan_number="CH-9")],
     "trigger": "b", "kind": "resend", "expect": {"total": 60, "meaning": {"duplicate"}}},
    {"name": "edited 60 -> 100", "nodes": [ORDER, {**n("a", 60, "CH-11: 100 delivered", status="edited", qty_delivered=100, challan_number="CH-11"),
                                                   "versions": [{"text": "CH-11: 60 delivered", "at": T0.isoformat()}]}],
     "trigger": "a", "kind": "edit", "old_text": "CH-11: 60 delivered", "expect": {"total": 100, "meaning": {"edit", "correction"}}},
    {"name": "deleted message no longer counts", "nodes": [ORDER, n("a", 60, "Challan CH-1: 60 delivered", qty_delivered=60, challan_number="CH-1"),
                                                           n("b", 70, "Challan CH-2: 40 delivered", status="deleted", qty_delivered=40, challan_number="CH-2")],
     "trigger": "b", "kind": "delete", "expect": {"total": 60, "meaning": {"retraction"}}},
    {"name": "two open POs, message names none", "nodes": [ORDER, n("a", 60, "PO-184: 20 delivered", qty_delivered=20, po_ref="PO-184"),
                                                           n("b", 300, "40 delivered", qty_delivered=40)],
     "memory_pos": ["PO-184", "PO-185"], "trigger": "b", "expect": {"link": "ask_which_po", "meaning": {"delivery", "question", "extra_delivery"}}},
    {"name": "same challan number photographed twice", "nodes": [ORDER, n("a", 60, "DC No: 77, qty 60 dispatched", qty_delivered=60, challan_number="77"),
                                                                 n("b", 240, "DC No: 77 qty 60 dispatched (clearer photo)", qty_delivered=60, challan_number="77")],
     "trigger": "b", "expect": {"total": 60, "meaning": {"duplicate", "delivery"}}},
    {"name": "Telugu: inka nalabhai vachayi (40 more came)", "nodes": [ORDER, n("a", 60, "Challan CH-3: 60 delivered", qty_delivered=60, challan_number="CH-3"),
                                                                        n("b", 180, "inka nalabhai boxes vachayi", qty_delivered=40, is_incremental=True)],
     "trigger": "b", "expect": {"total": 100, "meaning": {"extra_delivery"}}},
    {"name": "payment message does not change delivery", "nodes": [ORDER, n("a", 60, "Challan CH-5: 60 delivered", qty_delivered=60, challan_number="CH-5"),
                                                                   n("b", 600, "Rs 50,000 received via NEFT for PO-184", payment_amount=50000, po_ref="PO-184")],
     "trigger": "b", "expect": {"total": 60, "meaning": {"payment"}}},
]


# ------------------------------------------------------------------ oracle: the old static rules
def oracle(case: dict[str, Any]) -> dict[str, Any]:
    from app.validator import derive_facts

    if len(case.get("memory_pos") or []) > 1 and "PO-" not in next(x for x in case["nodes"] if x["node_id"] == case["trigger"])["text"]:
        return {"link": "ask_which_po"}
    nodes = [{"id": x["node_id"], "kind": x["kind"], "source": x["source"], "ts": x["at"], "fields": {**x["fields"], "po_ref": x["fields"].get("po_ref") or "PO-184"},
              "quarantined": False} for x in case["nodes"] if x["status"] not in ("deleted", "duplicate")]
    f = derive_facts(nodes, "PO-184")
    return {"total": float(f.delivered_qty) if f.delivered_qty is not None else None}


def _ok(exp: dict[str, Any], got: dict[str, Any]) -> bool:
    if "link" in exp:
        return got.get("link") == exp["link"]
    return got.get("total") is not None and abs(float(got["total"]) - exp["total"]) < 1e-9


# ------------------------------------------------------------------ real model through the production prompt + tool loop
def _tool_result(case: dict[str, Any], name: str) -> dict[str, Any]:
    from app.untrusted import wrap_untrusted

    if name == "read_case_timeline":
        nodes = []
        for x in case["nodes"]:
            f = x["fields"]
            nodes.append({"node_id": x["node_id"], "at": x["at"], "kind": x["kind"], "source_label": "WhatsApp", "text": wrap_untrusted(x["text"], "whatsapp", x["node_id"], preamble=False),
                          "status": x["status"], "versions": x.get("versions") or [], "duplicate_of": f.get("duplicate_of"), "challan_number": f.get("challan_number"),
                          "qty": f.get("qty_delivered", f.get("qty_ordered")), "qty_kind": "delivered" if "qty_delivered" in f else ("ordered" if "qty_ordered" in f else None),
                          "po_ref": f.get("po_ref"), "is_correction": bool(f.get("is_correction")), "is_incremental": bool(f.get("is_incremental"))})
        return {"ok": True, "data": {"case_ref": "RG-1042", "po_ref": "PO-184", "customer": "Example Customer Pvt Ltd", "state": "WATCHING", "nodes": nodes}}
    if name == "read_chat_memory":
        pos = case.get("memory_pos") or ["PO-184"]
        return {"ok": True, "data": {"chats": [{"chat_id": CHAT, "cases": [{"po": p, "case_number": f"RG-{1042 + i}"} for i, p in enumerate(pos)]}]}}
    if name == "search_cases":
        pos = case.get("memory_pos") or ["PO-184"]
        return {"ok": True, "data": {"cases": [{"case_ref": f"RG-{1042 + i}", "po_ref": p, "state": "WATCHING"} for i, p in enumerate(pos)]}}
    if name == "propose_timeline":
        return {"ok": True, "data": {"note": "checks run after you answer"}}
    return {"ok": True, "data": {}}


async def run_model(case: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str], float]:
    from app.llm import tool_loop
    from app.llm.router import extract_json
    from app.schemas import TimelineDecision
    from app.timeline import SYSTEM_PROMPT, TOOL_SPECS, user_message
    from app.timeline_verify import verify

    trig_node = next(x for x in case["nodes"] if x["node_id"] == case["trigger"])
    trigger = {"kind": case.get("kind", "message"), "node_id": case["trigger"], "chat_key": CHAT, "source": "whatsapp",
               "text": trig_node["text"] if case.get("kind") != "delete" else "", "old_text": case.get("old_text")}
    snap = {"case": {"case_number": "RG-1042", "po_ref": "PO-184", "customer": "Example Customer Pvt Ltd", "state": "WATCHING"},
            "facts": {"order_qty": 100, "rate": 1000, "item": "Model X"}}
    msgs: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user_message(snap, {k: v for k, v in trigger.items() if v})}]
    t0 = time.perf_counter()
    for step in range(10):
        turn = await tool_loop.chat_with_tools("timeline_eval", msgs, TOOL_SPECS, step=step)
        if turn.tool_calls:
            msgs.append({"role": "assistant", "content": turn.content or None,
                         "tool_calls": [{"id": t.id, "type": "function", "function": {"name": t.name, "arguments": json.dumps(t.args)}} for t in turn.tool_calls]})
            for t in turn.tool_calls:
                msgs.append({"role": "tool", "tool_call_id": t.id, "content": json.dumps({"tool": t.name, "result": _tool_result(case, t.name)})})
            continue
        try:
            d = TimelineDecision.model_validate(extract_json(turn.content)).model_dump()
        except Exception as e:  # noqa: BLE001
            return None, [f"invalid output: {str(e)[:200]}"], time.perf_counter() - t0
        nodes = {x["node_id"]: {"id": x["node_id"], "tenant_id": "t", "excerpt": x["text"], "fields": x["fields"] | {"status": x["status"]}} for x in case["nodes"]}
        ok, failed = verify(d, nodes, tenant_id="t", cases={"RG-1042": {"case_number": "RG-1042", "po_ref": "PO-184"}, "": {"case_number": "RG-1042", "po_ref": "PO-184"}},
                            trigger_text=trigger["text"])
        return d, failed, time.perf_counter() - t0
    return None, ["no answer within 10 turns"], time.perf_counter() - t0


async def main() -> dict[str, Any]:
    rows, o_ok, m_ok, m_ran = [], 0, 0, 0
    live = bool(os.environ.get("NVIDIA_API_KEY") or os.environ.get("GROQ_API_KEY"))
    for c in CASES:
        o = oracle(c)
        oc = _ok(c["expect"], o)
        o_ok += oc
        row: dict[str, Any] = {"name": c["name"], "expect": {k: (sorted(v) if isinstance(v, set) else v) for k, v in c["expect"].items()}, "oracle": o, "oracle_ok": oc}
        if live:
            d, failed, secs = await run_model(c)
            got = {"total": ((d or {}).get("delivered") or {}).get("total"), "link": ((d or {}).get("link") or {}).get("action"), "meaning": (d or {}).get("meaning")}
            good = d is not None and not failed and _ok(c["expect"], got) and got["meaning"] in c["expect"]["meaning"]
            m_ran += 1
            m_ok += good
            row.update(model=got, model_ok=good, failed_checks=failed, explanation=(d or {}).get("explanation_for_owner"), seconds=round(secs, 1))
        rows.append(row)
        print(f"{'OK ' if row.get('model_ok', oc) else 'X  '} {c['name']:<48} oracle={o} " + (f"model={row.get('model')} checks={row.get('failed_checks')}" if live else ""))
    out = {"at": datetime.now(timezone.utc).isoformat(), "cases": len(CASES), "oracle_correct": o_ok,
           "model": None if not live else {"correct": m_ok, "ran": m_ran, "accuracy": round(m_ok / m_ran, 3) if m_ran else None},
           "skipped_model": None if live else "NVIDIA_API_KEY not set: real model not run", "rows": rows}
    print(f"\noracle (static rules): {o_ok}/{len(CASES)}")
    print(f"model (timeline agent): {m_ok}/{m_ran} = {out['model']['accuracy']}" if live else "model: SKIPPED (set NVIDIA_API_KEY to run the real model)")
    (ROOT / "results").mkdir(exist_ok=True)
    (ROOT / "results" / "timeline_latest.json").write_text(json.dumps(out, indent=1, default=str))
    return out


if __name__ == "__main__":
    asyncio.run(main())
