"""Event bus: Redis pub/sub fan-out to WebSocket clients (in-process fallback when Redis is absent)."""
from __future__ import annotations

import asyncio
import json
from collections import deque
from typing import Any

from .config import get_settings
from .observability import get_logger

log = get_logger("events")
CHANNEL_PREFIX = "rg:events:"


class EventBus:
    def __init__(self) -> None:
        self._redis = None
        self._redis_checked = False
        self._subscribers: dict[str, set[asyncio.Queue]] = {}
        self._listener_task: asyncio.Task | None = None
        self.recent: deque[dict[str, Any]] = deque(maxlen=500)

    async def _get_redis(self):
        if self._redis_checked:
            return self._redis
        self._redis_checked = True
        try:
            import redis.asyncio as aioredis

            r = aioredis.from_url(get_settings().redis_url, socket_connect_timeout=1.5)
            await asyncio.wait_for(r.ping(), 2)
            self._redis = r
        except Exception as e:  # noqa: BLE001
            log.warning("events.redis_unavailable", error=str(e))
            self._redis = None
        return self._redis

    async def publish(self, tenant_id: str, event: dict[str, Any]) -> None:
        self.recent.append({"tenant_id": tenant_id, **event})
        r = await self._get_redis()
        if r is not None:
            try:
                await r.publish(CHANNEL_PREFIX + tenant_id, json.dumps(event, default=str))
                return
            except Exception as e:  # noqa: BLE001
                log.warning("events.publish_failed", error=str(e))
        self._dispatch_local(tenant_id, event)

    def _dispatch_local(self, tenant_id: str, event: dict[str, Any]) -> None:
        for q in list(self._subscribers.get(tenant_id, ())):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    async def start_listener(self) -> None:
        r = await self._get_redis()
        if r is None or self._listener_task:
            return

        async def _listen():
            while True:
                try:
                    pubsub = r.pubsub()
                    await pubsub.psubscribe(CHANNEL_PREFIX + "*")
                    async for msg in pubsub.listen():
                        if msg.get("type") != "pmessage":
                            continue
                        channel = msg["channel"].decode() if isinstance(msg["channel"], bytes) else msg["channel"]
                        tenant_id = channel[len(CHANNEL_PREFIX):]
                        try:
                            self._dispatch_local(tenant_id, json.loads(msg["data"]))
                        except Exception:  # noqa: BLE001
                            continue
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    log.warning("events.listener_error", error=str(e))
                    await asyncio.sleep(1)

        self._listener_task = asyncio.create_task(_listen())

    async def stop(self) -> None:
        if self._listener_task:
            self._listener_task.cancel()
            self._listener_task = None

    def subscribe(self, tenant_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subscribers.setdefault(tenant_id, set()).add(q)
        return q

    def unsubscribe(self, tenant_id: str, q: asyncio.Queue) -> None:
        self._subscribers.get(tenant_id, set()).discard(q)


bus = EventBus()


async def emit(tenant_id: str, type_: str, **data: Any) -> None:
    await bus.publish(tenant_id, {"type": type_, **data})


async def guardrail(tenant_id: str, case_id: str | None, kind: str, detail: Any) -> None:
    await emit(tenant_id, "guardrail", case_id=case_id, kind=kind, detail=detail)
