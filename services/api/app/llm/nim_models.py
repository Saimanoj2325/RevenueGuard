"""NVIDIA NIM model auto-pick.

NVIDIA adds and removes models on the free endpoint without notice (a model that answered in the morning can
return 404 by evening). So NIM_MODEL / NIM_VISION_MODEL are a *preference list*, not one fixed name:

    NIM_MODEL=auto                                   -> built-in list below
    NIM_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b -> try this first, then the built-in list
    NIM_MODEL=a,b,c                                  -> try a, then b, then c, then the built-in list

The first model that answers a tiny request is used and remembered for 30 minutes. A model that returns 404 or
times out during real work is skipped for 15 minutes and the next one is picked. No .env edits needed.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

from ..config import get_settings
from ..observability import get_logger

log = get_logger("nim_models")

# Order = what we prefer. Checked live 2026-10-20: nemotron-3.5-super-vl ~0.5 s (text+image, tool calling, JSON),
# gpt-oss-20b ~1.3 s (text, tools), deepseek-v4.1-flash and nemotron-3-super went 404 that evening.
BUILTIN = {
    "text": [
        "nvidia/nemotron-3.5-super-vl-120b-a12b",
        "openai/gpt-oss-20b",
        "deepseek-ai/deepseek-v4.1-flash",
        "nvidia/nemotron-3-super-120b-a12b",
        "nvidia/nemotron-3.5-lightning-30b-a3b",
        "z-ai/glm-5.3-flash",
    ],
    "vision": [
        "nvidia/nemotron-3.5-super-vl-120b-a12b",
        "deepseek-ai/deepseek-v4.1-flash",
    ],
}
KEEP_SECONDS = 30 * 60
BAD_SECONDS = 15 * 60
PROBE_TIMEOUT = 12.0
# a model that answers but takes longer than this is kept only as a last resort: the next candidate is tried first
SLOW_PROBE_MS = 5000

_picked: dict[str, dict[str, Any]] = {}
_bad: dict[str, dict[str, Any]] = {}
_tried: dict[str, list[dict[str, Any]]] = {}
_lock = asyncio.Lock()


def _configured(kind: str) -> str:
    s = get_settings()
    return (s.nim_vision_model if kind == "vision" else s.nim_model) or "auto"


def candidates(kind: str = "text") -> list[str]:
    out: list[str] = []
    for m in [x.strip() for x in _configured(kind).split(",")] + BUILTIN.get(kind, BUILTIN["text"]):
        if m and m.lower() != "auto" and m not in out:
            out.append(m)
    return out


def first_choice(kind: str = "text") -> str:
    return candidates(kind)[0]


def is_bad(model: str) -> bool:
    b = _bad.get(model)
    return bool(b and b["until"] > time.time())


def mark_bad(model: str, reason: str) -> None:
    _bad[model] = {"until": time.time() + BAD_SECONDS, "reason": reason[:160]}
    for kind, p in list(_picked.items()):
        if p.get("model") == model:
            _picked.pop(kind, None)
    log.warning("nim.model_skipped", model=model, reason=reason[:160])


def looks_gone(err: Exception | str) -> bool:
    """404 (model removed / not on this account), 410 (deprecated) or no reply in time."""
    s = str(err)
    low = s.lower()
    return any(x in s for x in ("404", "410")) or "not found" in low or "timeout" in low or "timed out" in low \
        or "TimeoutError" in s or "deprecated" in low or "end of life" in low


async def _probe(model: str, timeout: float = PROBE_TIMEOUT) -> tuple[bool, int, str | None]:
    from openai import AsyncOpenAI

    s = get_settings()
    t0 = time.perf_counter()
    try:
        client = AsyncOpenAI(base_url=s.nim_base_url, api_key=s.nvidia_api_key, timeout=timeout, max_retries=0)
        await asyncio.wait_for(client.chat.completions.create(
            model=model, messages=[{"role": "user", "content": "Reply with just: OK"}], max_tokens=16, temperature=0), timeout + 1)
        return True, int((time.perf_counter() - t0) * 1000), None
    except Exception as e:  # noqa: BLE001
        return False, int((time.perf_counter() - t0) * 1000), f"{type(e).__name__}: {str(e)[:140]}"


async def pick(kind: str = "text", force: bool = False) -> str:
    """The NIM model to use now. Without a key (demo/tests) this is just the first configured name."""
    s = get_settings()
    if not s.nvidia_api_key:
        return first_choice(kind)
    p = _picked.get(kind)
    if not force and p and time.time() - p["at"] < KEEP_SECONDS and not is_bad(p["model"]):
        return p["model"]
    async with _lock:
        p = _picked.get(kind)
        if not force and p and time.time() - p["at"] < KEEP_SECONDS and not is_bad(p["model"]):
            return p["model"]
        tried: list[dict[str, Any]] = []
        slow: list[tuple[int, str]] = []
        for m in candidates(kind):
            if is_bad(m) and not force:
                tried.append({"model": m, "ok": False, "error": _bad[m]["reason"], "skipped": True})
                continue
            ok, ms, err = await _probe(m)
            tried.append({"model": m, "ok": ok, "latency_ms": ms, "error": err})
            if ok and ms > SLOW_PROBE_MS:
                tried[-1]["slow"] = True
                slow.append((ms, m))
                log.warning("nim.model_slow", model=m, latency_ms=ms)
                continue
            if ok:
                _bad.pop(m, None)
                _picked[kind] = {"model": m, "at": time.time(), "latency_ms": ms}
                _tried[kind] = tried
                if m != first_choice(kind):
                    log.warning("nim.model_auto_picked", kind=kind, model=m, wanted=first_choice(kind))
                return m
            mark_bad(m, err or "no reply")
        _tried[kind] = tried
        if slow:  # every fast model is gone: use the quickest slow one rather than none
            ms, m = min(slow)
            _picked[kind] = {"model": m, "at": time.time(), "latency_ms": ms}
            return m
        return first_choice(kind)  # nothing answered: callers fail over to Groq/Ollama


def status(kind: str = "text") -> dict[str, Any]:
    p = _picked.get(kind) or {}
    return {"model": p.get("model"), "wanted": first_choice(kind), "tried": _tried.get(kind, []),
            "auto": p.get("model") not in (None, first_choice(kind))}


def reset() -> None:
    _picked.clear(); _bad.clear(); _tried.clear()
