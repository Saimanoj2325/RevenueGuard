"""Deterministic keyword heuristic used when Laya weights are unavailable (answers flagged fallback=true).

Kept byte-identical in services/laya/laya_service/heuristic.py and services/api/app/laya_heuristic.py.
"""
from __future__ import annotations

import json
import re
from typing import Any

INJECTION_PATTERNS = [
    r"\bSYSTEM\s*:",
    r"\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|earlier)\b.{0,20}\b(instruction|prompt|rule)s?",
    r"\byou are (now )?(an?|the) (ai|assistant|agent|model|system)\b",
    r"\b(mark|set|update)\b.{0,30}\b(as )?(paid|closed|resolved|approved)\b",
    r"\bclose (the|this) case\b",
    r"\b(approve|execute|run)\b.{0,20}\b(immediately|now|without (review|approval))\b",
    r"\bnew instructions?\b",
    r"</?\s*(system|assistant|untrusted_source)\b",
    r"\bdeveloper mode\b",
    r"\bcall (the )?tool\b",
]

EXCEPTION_KEYWORDS = [
    ("duplicate_invoice", [r"duplicate invoice", r"invoiced twice", r"billed twice", r"two invoices", r"double invoice"]),
    ("partial_payment", [r"partial payment", r"part payment", r"short[- ]?paid", r"paid (only|partially)", r"balance (due|pending)"]),
    ("quantity_conflict", [r"\bcorrection\b", r"mismatch", r"discrepan", r"conflict", r"actually \d+"]),
    ("billing_not_due", [r"not (yet )?due", r"bill (after|on) completion", r"invoice (after|next) (month|week)", r"billing (later|on hold)"]),
    ("partial_delivery", [r"\bpartial\b", r"\bbaaki\b", r"\bpending \d+", r"remaining \d+", r"\d+ (of|out of) \d+", r"balance (qty|quantity|units)"]),
    ("missing_invoice", [r"\bP\.?O\.?[\s#:\-]*\d+", r"purchase order", r"\border (confirm|placed|confirmation)", r"invoice (not|missing)", r"please (raise|send) (the )?invoice"]),
]

SEVERITY_LEVELS = ["low", "medium", "high", "critical"]


def _text(state: Any) -> str:
    if isinstance(state, str):
        return state
    try:
        return json.dumps(state, ensure_ascii=False)
    except TypeError:
        return str(state)


def _amount(text: str) -> float | None:
    """Largest rupee amount mentioned (a unit rate must not set the severity of a whole order)."""
    vals = []
    for m in re.finditer(r"(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)", text, re.I):
        try:
            vals.append(float(m.group(1).replace(",", "")))
        except ValueError:
            pass
    for m in re.finditer(r"\"amount\"\s*:\s*([\d.]+)", text):
        vals.append(float(m.group(1)))
    return max(vals) if vals else None


def injection_prob(text: str) -> float:
    hits = sum(1 for p in INJECTION_PATTERNS if re.search(p, text, re.I))
    if hits == 0:
        return 0.03
    return min(0.99, 0.75 + 0.1 * hits)


def classify_exception(text: str, options: list[str]) -> dict[str, float]:
    scores = {o: 0.0 for o in options}
    for label, pats in EXCEPTION_KEYWORDS:
        if label not in scores:
            continue
        for p in pats:
            if re.search(p, text, re.I):
                scores[label] += 1.0
    if "none" in scores:
        scores["none"] = 0.4
    total = sum(scores.values()) or 1.0
    # softmax-ish normalisation with a floor
    probs = {k: (v + 0.05) / (total + 0.05 * len(scores)) for k, v in scores.items()}
    z = sum(probs.values())
    return {k: round(v / z, 4) for k, v in probs.items()}


def severity(text: str, options: list[str]) -> dict[str, float]:
    amt = _amount(text) or 0
    if amt >= 500000:
        idx = 3
    elif amt >= 100000:
        idx = 2
    elif amt >= 25000:
        idx = 1
    else:
        idx = 0
    if re.search(r"urgent|immediately|overdue|legal|escalat", text, re.I):
        idx = min(3, idx + 1)
    opts = options or SEVERITY_LEVELS
    idx = min(idx, len(opts) - 1)
    probs = {o: 0.05 for o in opts}
    probs[opts[idx]] = 1 - 0.05 * (len(opts) - 1)
    return probs


def answer(state: Any, questions: list[dict[str, Any]]) -> dict[str, Any]:
    text = _text(state)
    out: dict[str, Any] = {}
    for q in questions:
        qid, qtype = q["id"], q.get("type", "noul")
        qtext = (q.get("text") or "").lower()
        opts = list(q.get("options") or [])
        if qtype == "noul":
            if "instruction" in qtext or "injection" in qid:
                p = injection_prob(text)
            elif "genuine" in qid or "genuine" in qtext:
                has_ref = bool(re.search(r"\bP\.?O\.?[\s#:\-]*\d+|\bSO[\s#:\-]*\d+|order", text, re.I))
                has_amt = _amount(text) is not None or bool(re.search(r"\b\d+\s*(units|boxes|pcs|nos)\b", text, re.I))
                p = 0.88 if (has_ref and has_amt) else (0.72 if has_ref else 0.35)
            elif "review" in qid or "review" in qtext:
                p = 0.6 if injection_prob(text) > 0.5 else 0.2
            else:
                p = 0.5
            out[qid] = {"value": p >= 0.5, "probs": {"true": round(p, 4), "false": round(1 - p, 4)}}
        elif qtype == "choice":
            probs = classify_exception(text, opts) if opts else {}
            best = max(probs, key=probs.get) if probs else None
            out[qid] = {"value": best, "probs": probs}
        elif qtype == "score":
            probs = severity(text, opts)
            best = max(probs, key=probs.get)
            out[qid] = {"value": best, "probs": probs}
    return out
