"""One model turn with tools, for the built-in agent runner (the harness has its own loop).

Uses the same providers and circuit breakers as the LLM router (NIM -> Groq -> Ollama). Only LIVE providers are
used: a mock slot never pretends to reason here (the caller decides what demo mode does instead).
If a provider rejects the `tools` parameter we fall back to a plain JSON protocol:
  {"tool": "<name>", "args": {...}}  or  {"final": {...}}
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any

from ..observability import get_logger
from .router import PRICE_INR_PER_1K, LLMUnavailable, extract_json, get_llm

log = get_logger("tool_loop")


@dataclass
class ToolCallOut:
    id: str
    name: str
    args: dict[str, Any]


@dataclass
class TurnResult:
    content: str
    tool_calls: list[ToolCallOut] = field(default_factory=list)
    provider: str = ""
    model: str = ""
    tokens: int = 0
    cost_inr: float = 0.0
    latency_ms: int = 0
    protocol: str = "tools"  # tools | json


def live_available() -> bool:
    """True when at least one real (non-mock) model is configured."""
    return any(not p.mock and p.api_key for p in get_llm().providers)


def _json_protocol_note(tools: list[dict[str, Any]]) -> str:
    names = ", ".join(t["function"]["name"] for t in tools)
    return ("\n\nTOOL PROTOCOL: reply with ONE JSON object only. To call a tool: {\"tool\": \"<name>\", \"args\": {...}} "
            f"(tools: {names}; put a short 'why' inside args). When finished: {{\"final\": <your decision JSON>}}.")


def _from_json_protocol(content: str, step: int) -> tuple[str, list[ToolCallOut]]:
    try:
        obj = extract_json(content)
    except (json.JSONDecodeError, ValueError):
        return content, []
    if isinstance(obj, dict) and obj.get("tool"):
        return "", [ToolCallOut(id=f"json_{step}", name=str(obj["tool"]), args=dict(obj.get("args") or {}))]
    if isinstance(obj, dict) and "final" in obj:
        return json.dumps(obj["final"]), []
    return content, []


async def chat_with_tools(task: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]], *, max_tokens: int = 1200,
                          step: int = 0, tenant_id: str | None = None, case_id: str | None = None) -> TurnResult:
    """One assistant turn. Raises LLMUnavailable when no live model answers."""
    from openai import AsyncOpenAI, BadRequestError

    from ..config import get_settings

    s = get_settings()
    router = get_llm()
    errors: list[str] = []
    for p in router.providers:
        if p.mock or not p.api_key:
            continue
        t0 = time.perf_counter()
        if p.name == "nim":
            from .nim_models import pick

            p.model = await pick("text")

        async def _do(p=p):
            client = AsyncOpenAI(base_url=p.base_url, api_key=p.api_key, timeout=s.llm_timeout_seconds, max_retries=0)
            try:
                resp = await client.chat.completions.create(model=p.model, messages=messages, tools=tools, tool_choice="auto",
                                                            temperature=0, max_tokens=max_tokens)
                return resp, "tools"
            except BadRequestError:
                # provider/model has no tool calling: same conversation, JSON protocol instead
                msgs = [dict(m) for m in messages if m.get("role") != "tool" and not m.get("tool_calls")]
                msgs[0] = {**msgs[0], "content": str(msgs[0]["content"]) + _json_protocol_note(tools)}
                for m in messages:
                    if m.get("role") == "tool":
                        msgs.append({"role": "user", "content": f"TOOL RESULT:\n{m['content']}"})
                resp = await client.chat.completions.create(model=p.model, messages=msgs, temperature=0, max_tokens=max_tokens,
                                                            response_format={"type": "json_object"})
                return resp, "json"

        try:
            resp, proto = await p.breaker.call(lambda: asyncio.wait_for(_do(), s.llm_timeout_seconds + 2))
        except Exception as e:  # noqa: BLE001  (timeouts, HTTP errors, open breaker)
            errors.append(f"{p.name}: {type(e).__name__}: {str(e)[:120]}")
            if p.name == "nim":
                from .nim_models import looks_gone, mark_bad

                if looks_gone(e):
                    mark_bad(p.model, f"{type(e).__name__}: {str(e)[:120]}")
            log.warning("tool_loop.provider_failed", task=task, provider=p.name, error=str(e)[:160])
            continue
        msg = resp.choices[0].message
        tokens = (resp.usage.total_tokens if resp.usage else 0) or len(json.dumps(messages, default=str)) // 4
        out = TurnResult(content=msg.content or "", provider=p.name, model=p.model, tokens=tokens,
                         cost_inr=round(tokens / 1000 * PRICE_INR_PER_1K.get(p.name, 0.1), 4),
                         latency_ms=int((time.perf_counter() - t0) * 1000), protocol=proto)
        if proto == "tools":
            for tc in msg.tool_calls or []:
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                out.tool_calls.append(ToolCallOut(id=tc.id, name=tc.function.name, args=args if isinstance(args, dict) else {}))
        else:
            out.content, out.tool_calls = _from_json_protocol(out.content, step)
        if tenant_id:
            from ..events import emit

            await emit(tenant_id, "llm.provider", provider=p.name, model=p.model, task=task, case_id=case_id, mock=False)
        return out
    raise LLMUnavailable(f"no live model answered {task}: {errors or 'no live provider configured'}")
