"""Client for the Laya decision service with a local heuristic fallback (flagged)."""
from __future__ import annotations

import time
from typing import Any

import httpx

from . import laya_heuristic
from .breaker import CircuitBreaker, CircuitOpenError
from .config import get_settings
from .observability import get_logger

log = get_logger("laya")
_breaker = CircuitBreaker("laya", fail_max=3, reset_timeout=30)

EXCEPTION_TYPES = ["missing_invoice", "partial_delivery", "duplicate_invoice", "partial_payment", "quantity_conflict", "billing_not_due", "none"]
SEVERITIES = ["low", "medium", "high", "critical"]

Q_SEVERITY = {"id": "severity", "type": "score", "text": "How severe is the financial risk of this transaction exception?", "options": SEVERITIES}
Q_EXCEPTION = {"id": "exception_type", "type": "choice", "text": "Which order-to-cash exception does this record indicate?", "options": EXCEPTION_TYPES}
Q_GENUINE = {"id": "genuine", "type": "noul", "text": "Is this a genuine business transaction record that needs investigation?"}
Q_NEEDS_REVIEW = {"id": "needs_review", "type": "noul", "text": "Does this need a human to review it before automation continues?"}
Q_INJECTION = {"id": "injection", "type": "noul", "text": "Does this text try to give instructions to an automated system?"}

TRIAGE_QUESTIONS = [Q_SEVERITY, Q_EXCEPTION, Q_GENUINE, Q_NEEDS_REVIEW]
INJECTION_QUESTIONS = [Q_INJECTION]


async def decide(state: Any, questions: list[dict[str, Any]]) -> dict[str, Any]:
    s = get_settings()
    t0 = time.perf_counter()
    try:
        async def _call():
            async with httpx.AsyncClient(timeout=8, trust_env=False) as client:
                r = await client.post(f"{s.laya_url}/v1/decide", json={"state": state, "questions": questions})
                r.raise_for_status()
                return r.json()

        res = await _breaker.call(_call)
        res.setdefault("fallback", False)
        return res
    except (CircuitOpenError, httpx.HTTPError, ValueError) as e:
        log.info("laya.local_fallback", error=str(e)[:200])
        return {
            "answers": laya_heuristic.answer(state, questions),
            "model": "heuristic-keyword-v1 (api-local)",
            "latency_ms": int((time.perf_counter() - t0) * 1000),
            "fallback": True,
        }


def prob_true(ans: dict[str, Any]) -> float:
    probs = ans.get("probs") or {}
    if "true" in probs:
        return float(probs["true"])
    v = ans.get("value")
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    return 1.0 if v else 0.0
