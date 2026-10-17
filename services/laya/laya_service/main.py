"""RevenueGuard Laya decision service (CONTRACT §Laya service).

POST /v1/decide {state, questions:[{id, type: choice|score|noul, text, options?}]}
  -> {answers: {id: {value, probs}}, model, latency_ms, fallback}

Uses the real `laya` Router (pip install laya; checkpoints convaiinnovations/laya on Hugging Face), on GPU when
available. Until weights are loaded — or if they cannot be — answers come from a deterministic keyword heuristic
and are flagged `fallback: true` so callers never mistake them for model output.
"""
from __future__ import annotations

import asyncio
import os
import threading
import time
from typing import Any, Literal, Optional, Union

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import heuristic

# Descriptions help the choice head; keys stay the contract labels.
CHOICE_HINTS = {
    "missing_invoice": "goods ordered or delivered but no invoice raised yet",
    "partial_delivery": "only part of the ordered quantity has been delivered",
    "duplicate_invoice": "the same order was invoiced more than once",
    "partial_payment": "customer paid less than the invoiced amount",
    "quantity_conflict": "records disagree about quantities, or a correction was sent",
    "billing_not_due": "invoice should not be raised yet under the billing terms",
    "none": "routine message with no order-to-cash problem",
}


class Question(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    type: Literal["choice", "score", "noul"]
    text: str = Field(min_length=1, max_length=2000)
    options: Optional[list[str]] = Field(default=None, max_length=100)


class DecideIn(BaseModel):
    state: Union[str, dict, list]
    questions: list[Question] = Field(min_length=1, max_length=32)
    model: Optional[str] = None


class Engine:
    def __init__(self) -> None:
        self.router = None
        self.error: str | None = None
        self.loading = False
        self.device = os.environ.get("LAYA_DEVICE") or None
        self.default_model = os.environ.get("LAYA_MODEL") or None  # english|multilingual|typed-decisions|None (auto-route)
        self._lock = threading.Lock()

    def load(self) -> None:
        if os.environ.get("LAYA_DISABLE") == "1":
            self.error = "disabled by LAYA_DISABLE=1"
            return
        self.loading = True
        try:
            from laya import Router

            device = self.device
            if device is None:
                try:
                    import torch

                    device = "cuda" if torch.cuda.is_available() else "cpu"
                except ImportError:
                    device = "cpu"
            self.device = device
            r = Router(device=device, max_loaded=int(os.environ.get("LAYA_MAX_LOADED", "2")))
            # warm the routed checkpoint(s) so the first real request is fast
            warm = os.environ.get("LAYA_WARM_MODELS", "english,multilingual").split(",")
            for m in [w.strip() for w in warm if w.strip()]:
                r.predict("warm up", {"q": {"type": "noul", "instructions": "Is this a test?"}}, model=m)
            self.router = r
        except Exception as e:  # noqa: BLE001
            self.error = f"{type(e).__name__}: {str(e)[:300]}"
        finally:
            self.loading = False

    @staticmethod
    def to_laya(questions: list[Question]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for q in questions:
            d: dict[str, Any] = {"type": q.type, "instructions": q.text}
            if q.type == "choice":
                d["criteria"] = {o: CHOICE_HINTS.get(o, o.replace("_", " ")) for o in (q.options or [])}
            elif q.type == "score":
                d["criteria"] = list(q.options or ["low", "medium", "high"])
            out[q.id] = d
        return out

    @staticmethod
    def from_laya(questions: list[Question], res: dict[str, Any]) -> dict[str, Any]:
        answers = {}
        for q in questions:
            a = (res.get("answers") or {}).get(q.id) or {}
            if q.type == "noul":
                p = float(a.get("noul", 0.0))
                answers[q.id] = {"value": p >= 0.5, "probs": {"true": round(p, 4), "false": round(1 - p, 4)}, "confidence": a.get("answer_confidence")}
            elif q.type == "choice":
                probs = a.get("probabilities") or {}
                answers[q.id] = {"value": a.get("choice"), "probs": {k: round(float(v), 4) for k, v in probs.items()}, "confidence": a.get("answer_confidence")}
            else:
                opts = list(q.options or [])
                legend = a.get("legend") or {str(i): o for i, o in enumerate(opts)}
                raw = a.get("probabilities") or {}
                probs = {legend.get(str(k), str(k)): round(float(v), 4) for k, v in raw.items()}
                score = float(a.get("score", 0.0))
                idx = max(0, min(len(opts) - 1, int(round(score)))) if opts else 0
                value = max(probs, key=probs.get) if probs else (opts[idx] if opts else score)
                answers[q.id] = {"value": value, "probs": probs, "score": score, "confidence": a.get("answer_confidence")}
        return answers

    def predict(self, state: Any, questions: list[Question], model: str | None) -> dict[str, Any]:
        with self._lock:  # torch modules are not re-entrant; one forward pass at a time per process
            return self.router.predict(state, self.to_laya(questions), model=model or self.default_model)


engine = Engine()
app = FastAPI(title="RevenueGuard Laya service", version="1.0.0")


@app.on_event("startup")
async def _startup() -> None:
    if os.environ.get("LAYA_PRELOAD", "1") == "1":
        threading.Thread(target=engine.load, daemon=True).start()


@app.get("/health")
async def health():
    return {"ok": True, "model_loaded": engine.router is not None, "loading": engine.loading, "device": engine.device, "error": engine.error,
            "fallback": engine.router is None}


@app.post("/v1/decide")
async def decide(body: DecideIn):
    t0 = time.perf_counter()
    if engine.router is not None:
        try:
            res = await asyncio.to_thread(engine.predict, body.state, body.questions, body.model)
            return {"answers": engine.from_laya(body.questions, res), "model": f"laya:{(res.get('routing') or {}).get('model', 'auto')}",
                    "routing": res.get("routing"), "latency_ms": int((time.perf_counter() - t0) * 1000), "fallback": False}
        except Exception as e:  # noqa: BLE001
            engine.error = f"predict failed: {type(e).__name__}: {str(e)[:200]}"
    try:
        answers = heuristic.answer(body.state, [q.model_dump() for q in body.questions])
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"heuristic failed: {e}") from e
    return {"answers": answers, "model": "heuristic-keyword-v1", "latency_ms": int((time.perf_counter() - t0) * 1000), "fallback": True,
            "reason": "weights loading" if engine.loading else (engine.error or "weights unavailable")}
