"""Live AI health: actually calls each model with a tiny request and reports what happened.

Used by GET /ai/health (Connections page, "AI models" section). Each probe is small and free-tier friendly:
  - NVIDIA NIM / Groq / Ollama: one chat completion "Reply with OK", max_tokens 5
  - Laya: GET /health on the Laya service (are the real weights loaded, or is it on the keyword fallback?)
  - Sarvam: one 1-second silent WAV sent to speech-to-text (key + endpoint check)
Results are cached for 30 s so a page refresh never hammers the providers; ?force=1 skips the cache.
Statuses: working | slow | down | not_set_up | demo
"""
from __future__ import annotations

import asyncio
import io
import time
import wave
from typing import Any

import httpx

from .config import get_settings
from .db import utcnow
from .observability import get_logger

log = get_logger("ai_probe")

SLOW_MS = 6000
_cache: dict[str, Any] = {"at": 0.0, "data": None}
_lock = asyncio.Lock()


def _ms(t0: float) -> int:
    return int((time.perf_counter() - t0) * 1000)


def _plain_error(e: Exception) -> str:
    s = f"{type(e).__name__}: {e}"
    low = s.lower()
    if "401" in s or "unauthorized" in low or "invalid api key" in low or "authentication" in low:
        return "Key rejected (401). Check the API key."
    if "403" in s:
        return "Access denied (403). The key may not have access to this model."
    if "404" in s or "not found" in low:
        return f"Not found (404): the model name or the address is wrong. Service said: {str(e)[:140]}"
    if "429" in s or "rate" in low:
        return "Rate limited (429). Free-tier limit hit, try again in a minute."
    if "timeout" in low or "timed out" in low:
        return "No reply in time (timeout)."
    if "connect" in low or "refused" in low or "name or service" in low or "nodename" in low:
        return "Cannot reach the service. Is it running?"
    return s[:160]


def _row(name: str, label: str, role: str, model: str, status: str, latency_ms: int | None = None,
         detail: str | None = None, error: str | None = None) -> dict[str, Any]:
    if status == "working" and latency_ms is not None and latency_ms > SLOW_MS:
        status = "slow"
    return {"name": name, "label": label, "role": role, "model": model, "status": status, "latency_ms": latency_ms,
            "detail": detail, "error": error, "checked_at": utcnow().isoformat()}


async def _chat(name: str, label: str, base_url: str, api_key: str, model: str, timeout: float) -> dict[str, Any]:
    from openai import AsyncOpenAI

    role = "Main AI (reads messages, runs agents)" if name == "nim" else "Backup AI" if name == "groq" else "Last backup, local"
    t0 = time.perf_counter()
    try:
        client = AsyncOpenAI(base_url=base_url, api_key=api_key, timeout=timeout, max_retries=0)
        r = await asyncio.wait_for(client.chat.completions.create(
            model=model, messages=[{"role": "user", "content": "Reply with just: OK"}], max_tokens=60, temperature=0,
            extra_body={"chat_template_kwargs": {"enable_thinking": False}} if name == "nim" else None), timeout + 2)
        txt = ((r.choices[0].message.content or "") if r.choices else "").strip()
        if not txt:
            return _row(name, label, role, model, "down", _ms(t0), error="Answered with an empty reply (model only produced reasoning).")
        return _row(name, label, role, model, "working", _ms(t0), f'Replied "{txt[:20] or "(empty)"}"')
    except Exception as e:  # noqa: BLE001
        err = _plain_error(e)
        if err.startswith("Not found (404)"):
            err = f"Model \"{model}\" not found at {base_url} (404). Check the model name in .env. " + err.split("Service said:", 1)[-1].strip()[:120]
        return _row(name, label, role, model, "down", _ms(t0), error=err)


async def probe_nim() -> dict[str, Any]:
    s = get_settings()
    if not s.nvidia_api_key:
        from .llm.nim_models import first_choice

        return _row("nim", "NVIDIA NIM", "Main AI (reads messages, runs agents)", first_choice("text"),
                    "demo" if s.demo_mode else "not_set_up", error=None if s.demo_mode else "NVIDIA_API_KEY is empty.")
    from .llm import nim_models

    model = await nim_models.pick("text", force=True)
    row = await _chat("nim", "NVIDIA NIM", s.nim_base_url, s.nvidia_api_key, model, 25)
    st = nim_models.status("text")
    gone = [t["model"].split("/")[-1] for t in st["tried"] if not t.get("ok")]
    slow = [t["model"].split("/")[-1] for t in st["tried"] if t.get("slow") and t["model"] != model]
    if slow:
        gone += [f"{m} (too slow)" for m in slow]
    if row["status"] in ("working", "slow"):
        if model != st["wanted"]:
            row["detail"] = f"Auto-picked. {', '.join(gone) or st['wanted']} not available on NVIDIA right now. " + (row.get("detail") or "")
        else:
            row["detail"] = "Auto-picked. " + (row.get("detail") or "")
    elif gone:
        row["error"] = f"No NVIDIA model answered (tried {', '.join(gone)}). Groq is doing the work."
    return row


async def probe_groq() -> dict[str, Any]:
    s = get_settings()
    if not s.groq_api_key:
        return _row("groq", "Groq", "Backup AI", s.groq_model, "demo" if s.demo_mode else "not_set_up",
                    error=None if s.demo_mode else "GROQ_API_KEY is empty.")
    return await _chat("groq", "Groq", s.groq_base_url, s.groq_api_key, s.groq_model, 15)


async def probe_ollama() -> dict[str, Any]:
    s = get_settings()
    root = s.ollama_base_url.rstrip("/").removesuffix("/v1")
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=5, trust_env=False) as c:
            r = await c.get(f"{root}/api/tags")
            r.raise_for_status()
            names = [m.get("name", "") for m in (r.json().get("models") or [])]
    except Exception as e:  # noqa: BLE001
        return _row("ollama", "Ollama", "Last backup, local", s.ollama_model, "down", _ms(t0), error=_plain_error(e))
    if not any(n == s.ollama_model or n.split(":")[0] == s.ollama_model.split(":")[0] for n in names):
        return _row("ollama", "Ollama", "Last backup, local", s.ollama_model, "down", _ms(t0),
                    error=f"Ollama is running but {s.ollama_model} is not pulled. Run: ollama pull {s.ollama_model}")
    return await _chat("ollama", "Ollama", s.ollama_base_url, "ollama", s.ollama_model, 60)


async def probe_laya() -> dict[str, Any]:
    s = get_settings()
    role = "Severity + prompt-injection check"
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=6, trust_env=False) as c:
            r = await c.get(f"{s.laya_url}/health")
            r.raise_for_status()
            h = r.json()
    except Exception as e:  # noqa: BLE001
        return _row("laya", "Laya", role, "laya", "down", _ms(t0),
                    error=_plain_error(e) + " Using the keyword fallback for now.")
    dev = h.get("device") or "?"
    if h.get("model_loaded"):
        return _row("laya", "Laya", role, f"laya ({dev})", "working", _ms(t0), f"Weights loaded on {dev}")
    if h.get("loading"):
        return _row("laya", "Laya", role, f"laya ({dev})", "slow", _ms(t0), "Weights still loading. Keyword fallback until ready.")
    return _row("laya", "Laya", role, f"laya ({dev})", "down", _ms(t0),
                error=f"Weights not loaded: {(h.get('error') or 'unknown')[:120]}. Using the keyword fallback.")


def _silent_wav(seconds: float = 1.0, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * seconds))
    return buf.getvalue()


async def probe_sarvam() -> dict[str, Any]:
    from .llm.stt_sarvam import SARVAM_STT_URL

    s = get_settings()
    role = "Voice notes (Hindi, Telugu, Hinglish)"
    if not s.sarvam_api_key:
        return _row("sarvam", "Sarvam", role, s.sarvam_stt_model, "demo" if s.demo_mode else "not_set_up",
                    error=None if s.demo_mode else "SARVAM_API_KEY is empty. Voice notes fall back to NIM / Groq Whisper.")
    form = {"model": s.sarvam_stt_model, "language_code": "unknown"}
    if s.sarvam_stt_model.endswith("v3"):
        form["mode"] = s.sarvam_stt_mode
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(SARVAM_STT_URL, headers={"api-subscription-key": s.sarvam_api_key}, data=form,
                             files={"file": ("probe.wav", _silent_wav(), "audio/wav")})
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:120]}")
        return _row("sarvam", "Sarvam", role, s.sarvam_stt_model, "working", _ms(t0), "Speech-to-text answered")
    except Exception as e:  # noqa: BLE001
        return _row("sarvam", "Sarvam", role, s.sarvam_stt_model, "down", _ms(t0), error=_plain_error(e))


ORDER = ["nim", "groq", "ollama", "laya", "sarvam"]
PROBES = {"nim": probe_nim, "groq": probe_groq, "ollama": probe_ollama, "laya": probe_laya, "sarvam": probe_sarvam}


async def probe_all(force: bool = False) -> dict[str, Any]:
    async with _lock:
        if not force and _cache["data"] and time.time() - _cache["at"] < 30:
            return _cache["data"]
        rows = await asyncio.gather(*(PROBES[n]() for n in ORDER), return_exceptions=True)
        out = []
        for n, r in zip(ORDER, rows):
            out.append(r if isinstance(r, dict) else _row(n, n.title(), "", "", "down", error=_plain_error(r)))
        by = {r["name"]: r for r in out}
        chain = [n for n in ("nim", "groq", "ollama") if by[n]["status"] in ("working", "slow", "demo")]
        summary = (f"Messages are read by {by[chain[0]]['label']}." if chain else
                   "No AI can read messages right now. New messages wait and are re-read when one is back.")
        data = {"models": out, "reader": chain[0] if chain else None, "summary": summary, "checked_at": utcnow().isoformat(),
                "demo_mode": get_settings().demo_mode}
        _cache.update(at=time.time(), data=data)
        log.info("ai_probe.done", statuses={r["name"]: r["status"] for r in out})
        return data
