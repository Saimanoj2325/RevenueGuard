"""Evaluation runner: rules-only vs fixed-sequence vs adaptive on the same labeled cases.

    python -m eval.generate
    python -m eval.run --split test                      # held-out set (default)
    python -m eval.run --split all --approaches adaptive  # any subset

Model approaches run the real API orchestrator in-process (DEMO_MODE, mock connectors, deterministic built-in agent
runner, SQLite) through the same intake / validator / approval / gateway / verifier code paths as production.
The rules-only baseline is plain exact-reference matching with direct writes (no approval gate, no read-back).
Writes eval/results/latest.json and eval/results/latest.md. Metrics always carry numerator and denominator.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import tempfile
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
API_DIR = ROOT.parent / "services" / "api"
DATA = ROOT / "data" / "cases.jsonl"
RESULTS = ROOT / "results"


def _env(db_path: str) -> None:
    os.environ.update(
        DATABASE_URL=f"sqlite+aiosqlite:///{db_path}", STORAGE_BACKEND="local", LOCAL_STORAGE_DIR=str(Path(db_path).parent / "objects"),
        DEMO_MODE="true", INLINE_WORKER="true", AGENT_RUNNER="builtin", LAYA_URL="http://127.0.0.1:1", HARNESS_URL="http://127.0.0.1:1",
        REDIS_URL="redis://127.0.0.1:1/0", LOG_LEVEL="ERROR", INTERNAL_HMAC_SECRET="eval", JWT_SECRET="eval",
    )
    for k in ("NVIDIA_API_KEY", "GROQ_API_KEY"):
        os.environ.pop(k, None)
    if str(API_DIR) not in sys.path:
        sys.path.insert(0, str(API_DIR))


def load_cases(split: str) -> list[dict[str, Any]]:
    if not DATA.exists():
        from eval.generate import main as gen

        gen()
    cases = [json.loads(line) for line in DATA.read_text().splitlines() if line.strip()]
    return cases if split == "all" else [c for c in cases if c["split"] == split]


# ------------------------------------------------------------------------------------------- rules-only baseline
def run_rules_only(case: dict[str, Any]) -> dict[str, Any]:
    t0 = time.perf_counter()
    ref, rate = case["ref"], Decimal(str(case["rate"]))
    invoices = [i for i in case["zoho"]["invoices"] if i.get("reference_number") == ref]  # exact string match only
    writes: list[dict[str, Any]] = []
    tool_calls = 3  # invoice lookup, sheet read, payment lookup
    if invoices:
        total = sum(Decimal(str(i["total"])) for i in invoices)
        paid = sum(Decimal(str(p["amount"])) for p in case["zoho"]["payments"] if p.get("reference_number") == ref)
        if Decimal(0) < paid < total:
            writes.append({"type": "send_reminder", "amount": float(total - paid)})
    else:
        amount = Decimal(case["sheet_qty"]) * rate  # trusts the sheet; ignores chats, corrections, billing delays
        writes.append({"type": "create_invoice", "amount": float(amount)})
        if "zoho_timeout_once" in case["chaos"]:
            writes.append({"type": "create_invoice", "amount": float(amount)})  # blind retry after timeout
    outcome = writes[0]["type"] if writes else "none"
    return {"outcome": outcome, "amount": writes[0]["amount"] if writes else 0, "writes": len(writes), "write_amounts": [w["amount"] for w in writes],
            "final_state": "AUTO", "flagged": bool(writes), "proposal_cited": None, "first_check_useful": None, "verified": None,
            "tool_calls": tool_calls, "latency_ms": int((time.perf_counter() - t0) * 1000), "cost_inr": 0.0}


# ------------------------------------------------------------------------------------------- model approaches
async def _make_tenant(case: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    from app.connectors.base import CONNECTOR_NAMES
    from app.db import session_scope, utcnow
    from app.flags import set_flag
    from app.models import Connector, Tenant, User
    from app.security import hash_password

    cid = f"{_MODE}-{case['id'].lower()}"
    async with session_scope() as s:
        t = Tenant(name=f"Eval {case['id']}", slug=f"eval-{cid}", case_seq=1041)
        s.add(t)
        await s.flush()
        users = {}
        for role, email in (("finance_approver", f"fin1+{cid}@eval.local"), ("finance_approver", f"fin2+{cid}@eval.local")):
            u = User(tenant_id=t.id, email=email, name=email, role=role, password_hash=_PW)
            s.add(u)
            users[email] = u
        data = {
            "zoho": case["zoho"],
            "sheets": {"rows": [{"row": 2, "po_ref": case["ref"], "customer": case["customer"], "item": case["item"], "qty_ordered": case["qty"],
                                 "qty_delivered": case["sheet_qty"], "qty_pending": case["qty"] - case["sheet_qty"], "updated_at": utcnow().isoformat()}]},
            "drive": {"docs": []}, "gmail": {"messages": [], "sent": []}, "whatsapp": {"sent": []},
        }
        for name in CONNECTOR_NAMES:
            s.add(Connector(tenant_id=t.id, name=name, status="connected", mode="mock", config={"rows": []} if name == "bank" else {"mock": data.get(name, {})}, authorized_by="eval"))
        await set_flag(s, t.id, "billing_rules", {"default": {"mode": "on_delivery"}, "customers": {case["customer_id"]: case["billing_rule"]}})
        for ch in case["chaos"]:
            await set_flag(s, t.id, f"chaos:{ch}", True)
        await s.flush()
        return t.id, {k: v for k, v in users.items()}


_PW = ""
_MODE = "adaptive"


async def run_model_case(case: dict[str, Any], mode: str) -> dict[str, Any]:
    from sqlalchemy import select

    from app import jobs
    from app.approvals import ApprovalError, approve, reject
    from app.connectors.registry import adapter
    from app.db import session_scope
    from app.demo.scenes import inject_gmail, inject_wa, set_sheet_row
    from app.gateway import execute
    from app.intake import IntakeItem, intake
    from app.models import Action, AgentRun, Approval, Case, Proposal, ToolCall, Verification
    from app.orchestrator.engine import drive_case

    t0 = time.perf_counter()
    jobs.SUPPRESS["depth"] += 1
    try:
        tid, users = await _make_tenant(case)
        u1, u2 = list(users.values())
        em = case["order_email"]
        await inject_gmail(tid, em["id"], em["subject"], em["text"], sender=f"{case['customer']} <ap@customer.in>")
        if any(e["type"] == "replay_email" for e in case["events"]):
            await intake(tid, IntakeItem(source="gmail", source_id=em["id"], subject=em["subject"], text=em["text"]), enqueue=False)
        await inject_wa(tid, case["dispatch_message"]["id"], case["dispatch_message"]["text"], chat=case["chat_id"])
        if any(e["type"] == "replay_email" for e in case["events"]):
            await inject_wa(tid, case["dispatch_message"]["id"], case["dispatch_message"]["text"], chat=case["chat_id"])

        async def the_case() -> Case | None:
            async with session_scope() as s:
                return (await s.execute(select(Case).where(Case.tenant_id == tid).order_by(Case.created_at))).scalars().first()

        c = await the_case()
        if c is None:
            return {"outcome": "none", "amount": 0, "writes": 0, "final_state": "NO_CASE", "flagged": False, "tool_calls": 0,
                    "latency_ms": int((time.perf_counter() - t0) * 1000), "proposal_cited": None, "first_check_useful": None, "verified": None, "cost_inr": 0.0}
        await drive_case(c.id)
        stale = [e for e in case["events"] if e["after"] == "proposal"]
        for ev in stale:
            c = await the_case()
            if c.state == "AWAITING_APPROVAL":
                await inject_wa(tid, f"{case['dispatch_message']['id']}-corr", ev["text"], chat=case["chat_id"])
                await set_sheet_row(tid, case["ref"], case["customer"], case["item"], case["qty"], ev["sheet_qty"])
                await drive_case(c.id)
        for _ in range(3):
            c = await the_case()
            if c.state != "AWAITING_APPROVAL":
                break
            async with session_scope() as s:
                ap = (await s.execute(select(Approval).where(Approval.case_id == c.id).order_by(Approval.created_at.desc()))).scalars().first()
            try:
                if case["approver"] == "reject":
                    await reject(ap.id, u1, "approver revoked: customer disputes the order")
                else:
                    await approve(ap.id, u1, "eval approver 1")
                    if ap.required_approvers > 1:
                        await approve(ap.id, u2, "eval approver 2")
            except ApprovalError:
                pass
            await drive_case(c.id)
            if any(e["type"] == "double_execute" for e in case["events"]):
                await asyncio.gather(execute(ap.id, "eval-double"), execute(ap.id, "eval-double"))
        c = await the_case()
        if c.state == "PAUSED":  # transient connector fault: one resume attempt, like the sweep would
            await drive_case(c.id)
            c = await the_case()
        async with session_scope() as s:
            acts = (await s.execute(select(Action).where(Action.case_id == c.id, Action.status == "succeeded"))).scalars().all()
            props = (await s.execute(select(Proposal).where(Proposal.case_id == c.id).order_by(Proposal.version.desc()))).scalars().all()
            vers = (await s.execute(select(Verification).where(Verification.case_id == c.id))).scalars().all()
            inv_runs = (await s.execute(select(AgentRun).where(AgentRun.case_id == c.id, AgentRun.agent == "investigation", AgentRun.status == "finished"))).scalars().all()
            n_tools = len((await s.execute(select(ToolCall.id).where(ToolCall.case_id == c.id))).all())
            runs = (await s.execute(select(AgentRun).where(AgentRun.case_id == c.id))).scalars().all()
            z = await adapter(s, tid, "zoho")
            rg_invoices = [i for i in await z.find_invoices_by_reference(case["ref"]) if any(cf.get("api_name") == "cf_rg_idempotency_key" for cf in i.get("custom_fields") or [])]
            wa_sent = ((await adapter(s, tid, "whatsapp")).conn.config.get("mock") or {}).get("sent", [])
            from app import case_service as cs

            facts = await cs.compute_facts(s, c)
        writes = len(rg_invoices) + len(wa_sent)
        a = acts[0] if acts else None
        outcome = a.type if a else ("escalate" if c.state in ("ESCALATED", "BLOCKED") else ("paused" if c.state == "PAUSED" else "none"))
        cited = None
        if props:
            p = props[0]
            valid = set(facts.evidence_node_ids)
            cited = bool(p.claims) and all(cl.get("evidence_node_ids") and all(n in valid for n in cl["evidence_node_ids"]) for cl in p.claims)
        first_useful = None
        if inv_runs:
            steps = (inv_runs[0].output or {}).get("steps") or []
            first_useful = bool(steps and steps[0].get("added_evidence"))
        return {
            "outcome": outcome, "amount": float(a.request.get("amount") or 0) if a else 0, "writes": writes,
            "write_amounts": [float(i["total"]) for i in rg_invoices] + [float(a.request.get("amount") or 0) for _ in wa_sent if a],
            "final_state": c.state, "flagged": bool(props) or c.state in ("ESCALATED", "BLOCKED"), "proposal_cited": cited,
            "first_check_useful": first_useful, "verified": (any(v.status == "pass" for v in vers) if a else None), "tool_calls": n_tools,
            "agent_runs": len(runs), "latency_ms": int((time.perf_counter() - t0) * 1000), "cost_inr": round(sum(r.cost_inr or 0 for r in runs), 4),
            "escalation_reason": c.escalation_reason,
        }
    finally:
        jobs.SUPPRESS["depth"] -= 1


# ------------------------------------------------------------------------------------------- scoring
def correct(case: dict[str, Any], r: dict[str, Any]) -> bool:
    exp = case["expected"]

    def match(e: dict[str, Any]) -> bool:
        if r["outcome"] != e["outcome"]:
            return False
        if e["outcome"] in ("create_invoice", "send_reminder"):
            return abs(float(r["amount"]) - float(e["amount"])) < 0.01 and r["writes"] == 1
        return r["writes"] == 0

    return match(exp) or (bool(exp.get("also_acceptable")) and match({**exp["also_acceptable"], "writes": 1}))


def unsafe_writes(case: dict[str, Any], r: dict[str, Any]) -> int:
    """Writes that should not have happened: any write when none is expected, or a write with the wrong amount."""
    exp = case["expected"]
    allowed_amounts = []
    if exp["outcome"] in ("create_invoice", "send_reminder"):
        allowed_amounts.append(float(exp["amount"]))
    if exp.get("also_acceptable"):
        allowed_amounts.append(float(exp["also_acceptable"]["amount"]))
    bad = 0
    for amt in r.get("write_amounts", []):
        if not any(abs(amt - x) < 0.01 for x in allowed_amounts):
            bad += 1
    return bad


def ratio(n: int, d: int) -> dict[str, Any]:
    return {"value": round(n / d, 4) if d else None, "numerator": n, "denominator": d}


def pct(vals: list[float], p: float) -> float | None:
    if not vals:
        return None
    v = sorted(vals)
    return v[min(len(v) - 1, int(round(p * (len(v) - 1))))]


def metrics(cases: list[dict[str, Any]], results: list[dict[str, Any]]) -> dict[str, Any]:
    tp = sum(1 for c, r in zip(cases, results) if r["flagged"] and c["expected"]["is_exception"])
    fp = sum(1 for c, r in zip(cases, results) if r["flagged"] and not c["expected"]["is_exception"])
    fn = sum(1 for c, r in zip(cases, results) if not r["flagged"] and c["expected"]["is_exception"])
    negatives = sum(1 for c in cases if not c["expected"]["is_exception"])
    with_prop = [r for r in results if r.get("proposal_cited") is not None]
    with_check = [r for r in results if r.get("first_check_useful") is not None]
    attempted = [r for r in results if r["outcome"] in ("create_invoice", "send_reminder")]
    dup = sum(max(0, r["writes"] - 1) for r in results)
    per: dict[str, dict[str, int]] = {}
    for c, r in zip(cases, results):
        d = per.setdefault(c["scenario"], {"correct": 0, "n": 0})
        d["n"] += 1
        d["correct"] += int(correct(c, r))
    lat = [r["latency_ms"] for r in results]
    return {
        "outcome_accuracy": ratio(sum(correct(c, r) for c, r in zip(cases, results)), len(cases)),
        "exception_precision": ratio(tp, tp + fp),
        "exception_recall": ratio(tp, tp + fn),
        "false_positive_rate": ratio(fp, negatives),
        "evidence_coverage": ratio(sum(1 for r in with_prop if r["proposal_cited"]), len(with_prop)),
        "useful_next_check_rate": ratio(sum(1 for r in with_check if r["first_check_useful"]), len(with_check)),
        "verified_resolution_rate": ratio(sum(1 for r in attempted if r.get("verified")), len(attempted)) if any(r.get("verified") is not None for r in attempted) else {"value": None, "numerator": 0, "denominator": len(attempted), "note": "no read-back verification in this approach"},
        "unsafe_writes": sum(unsafe_writes(c, r) for c, r in zip(cases, results)),
        "duplicate_writes": dup,
        "tool_calls_per_case": {"median": statistics.median([r["tool_calls"] for r in results]) if results else None, "total": sum(r["tool_calls"] for r in results)},
        "latency_ms": {"p50": pct(lat, 0.5), "p95": pct(lat, 0.95)},
        "model_cost_inr": {"total": round(sum(r.get("cost_inr", 0) for r in results), 4), "note": "deterministic mock providers in eval: 0 by construction"},
        "human_investigation_time": {"value": None, "note": "not measurable on synthetic cases; tool calls per case reported as an effort proxy"},
        "per_scenario": {k: ratio(v["correct"], v["n"]) for k, v in sorted(per.items())},
    }


def failures(cases, results, k=6):
    out = []
    for c, r in zip(cases, results):
        if not correct(c, r) or unsafe_writes(c, r) or r["writes"] > 1:
            out.append({"case": c["id"], "scenario": c["scenario"], "expected": c["expected"], "got": {kk: r.get(kk) for kk in ("outcome", "amount", "writes", "final_state", "escalation_reason")}})
    return out[:k]


async def run_model(cases: list[dict[str, Any]], mode: str) -> list[dict[str, Any]]:
    from app import db as dbm
    from app.config import get_settings
    from app.demo.fixtures import ensure_fixtures

    global _MODE
    from app import gateway
    from app.breaker import _registry
    from app.observability import configure_logging
    from app.orchestrator import locks

    configure_logging("ERROR")
    _MODE = mode
    get_settings().investigation_mode = mode
    locks._local.clear()  # asyncio primitives are bound to the previous event loop
    gateway._local_locks.clear()
    for b in _registry.values():
        b.reset()
    dbm.reset_engine()
    await dbm.create_all()
    ensure_fixtures()
    out = []
    for c in cases:
        try:
            out.append(await run_model_case(c, mode))
        except Exception as e:  # noqa: BLE001  (a crash is a failure, not a skipped case)
            out.append({"outcome": "error", "amount": 0, "writes": 0, "final_state": f"ERROR {type(e).__name__}: {str(e)[:120]}", "flagged": False,
                        "tool_calls": 0, "latency_ms": 0, "proposal_cited": None, "first_check_useful": None, "verified": None, "cost_inr": 0.0})
    await dbm.get_engine().dispose()
    return out


def write_report(payload: dict[str, Any]) -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "latest.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    a = payload["approaches"]
    names = list(a)
    rows = ["outcome_accuracy", "exception_precision", "exception_recall", "false_positive_rate", "evidence_coverage", "useful_next_check_rate", "verified_resolution_rate"]

    def fmt(m):
        if isinstance(m, dict) and "numerator" in m:
            v = m["value"]
            return f"{'n/a' if v is None else f'{v:.1%}'} ({m['numerator']}/{m['denominator']})"
        return str(m)

    lines = [f"# RevenueGuard AI — evaluation report", "", f"Generated {payload['generated_at']} · split `{payload['split']}` · {payload['n_cases']} cases · "
             f"{len(payload['scenarios'])} scenario types. Synthetic cases with known outcomes; these are measured results on this suite only, "
             "not claims about live business data.", "", "| Metric | " + " | ".join(names) + " |", "|---|" + "---|" * len(names)]
    for row in rows:
        lines.append(f"| {row.replace('_', ' ')} | " + " | ".join(fmt(a[n]["metrics"][row]) for n in names) + " |")
    for row in ("unsafe_writes", "duplicate_writes"):
        lines.append(f"| {row.replace('_', ' ')} (count) | " + " | ".join(str(a[n]["metrics"][row]) for n in names) + " |")
    lines.append("| tool calls / case (median) | " + " | ".join(str(a[n]["metrics"]["tool_calls_per_case"]["median"]) for n in names) + " |")
    lines.append("| latency p50 / p95 (ms) | " + " | ".join(f"{a[n]['metrics']['latency_ms']['p50']} / {a[n]['metrics']['latency_ms']['p95']}" for n in names) + " |")
    lines += ["", "## Accuracy by scenario", "", "| Scenario | " + " | ".join(names) + " |", "|---|" + "---|" * len(names)]
    for sc in payload["scenarios"]:
        lines.append(f"| {sc} | " + " | ".join(fmt(a[n]["metrics"]["per_scenario"].get(sc, {"value": None, "numerator": 0, "denominator": 0})) for n in names) + " |")
    lines += ["", "## Representative failures", ""]
    for n in names:
        lines.append(f"**{n}**")
        f = a[n]["failures"]
        if not f:
            lines.append("- none in this split")
        for x in f:
            lines.append(f"- `{x['case']}` {x['scenario']}: expected {x['expected']['outcome']} ₹{x['expected']['amount']}, got {x['got']['outcome']} ₹{x['got']['amount']} "
                         f"(writes {x['got']['writes']}, state {x['got']['final_state']})")
        lines.append("")
    lines += ["## Notes", "", "- Rules-only = exact-reference matching with direct writes (no approval, no read-back, blind retry on timeout).",
              "- Fixed-sequence = same orchestrator and guardrails, but investigation always runs the same 8 checks in the same order.",
              "- Adaptive = investigation picks the next read-only check from the current evidence gap.",
              "- Model approaches use the deterministic built-in agent runner and mock LLM providers so results are reproducible; "
              "a run against live NIM/Groq models through the Harness will differ and should be reported separately.",
              "- Human investigation time cannot be measured on synthetic data; tool calls per case are reported as an effort proxy."]
    (RESULTS / "latest.md").write_text("\n".join(lines) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="test", choices=["test", "dev", "all"])
    ap.add_argument("--approaches", default="rules_only,fixed_sequence,adaptive")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    cases = load_cases(args.split)
    if args.limit:
        cases = cases[: args.limit]
    tmp = tempfile.mkdtemp(prefix="rg-eval-")
    payload: dict[str, Any] = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "split": args.split, "n_cases": len(cases),
                               "scenarios": sorted({c["scenario"] for c in cases}), "approaches": {}}
    for name in [x.strip() for x in args.approaches.split(",") if x.strip()]:
        t0 = time.perf_counter()
        if name == "rules_only":
            res = [run_rules_only(c) for c in cases]
        else:
            _env(f"{tmp}/{name}.db")
            global _PW
            from app.security import hash_password

            _PW = _PW or hash_password("eval-not-a-login")
            res = asyncio.run(run_model(cases, "fixed" if name == "fixed_sequence" else "adaptive"))
        payload["approaches"][name] = {"metrics": metrics(cases, res), "failures": failures(cases, res), "seconds": round(time.perf_counter() - t0, 1),
                                       "cases": [{"id": c["id"], "scenario": c["scenario"], **{k: r.get(k) for k in ("outcome", "amount", "writes", "final_state", "tool_calls")}} for c, r in zip(cases, res)]}
        m = payload["approaches"][name]["metrics"]
        print(f"{name:15s} accuracy {m['outcome_accuracy']['numerator']}/{m['outcome_accuracy']['denominator']}  unsafe {m['unsafe_writes']}  dup {m['duplicate_writes']}  ({payload['approaches'][name]['seconds']}s)")
    write_report(payload)
    print(f"wrote {RESULTS / 'latest.json'} and {RESULTS / 'latest.md'}")


if __name__ == "__main__":
    main()
