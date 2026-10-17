"""structlog JSON logging with correlation ids and PII / bank-detail redaction; optional OpenTelemetry."""
from __future__ import annotations

import logging
import re
import sys
from contextvars import ContextVar
from typing import Any

import structlog

correlation_id_var: ContextVar[str | None] = ContextVar("correlation_id", default=None)
case_id_var: ContextVar[str | None] = ContextVar("case_id", default=None)

# Order matters: longer / more specific patterns first.
_REDACTIONS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b"), "[IFSC]"),  # Indian IFSC
    (re.compile(r"\b\d{9,18}\b"), "[ACCT/PHONE]"),  # bank a/c or bare phone numbers
    (re.compile(r"\+?\d{1,3}[\s-]?\d{5}[\s-]?\d{5}\b"), "[PHONE]"),
    (re.compile(r"\b\d{12,15}@s\.whatsapp\.net\b"), "[WA_JID]"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "[EMAIL]"),
    (re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b"), "[PAN]"),
    (re.compile(r"\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b"), "[GSTIN]"),
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]+"), r"\1[TOKEN]"),
]
_SENSITIVE_KEYS = {"password", "access_token", "refresh_token", "token", "auth_enc", "client_secret", "api_key", "base64", "authorization"}


def redact_text(value: str) -> str:
    for pat, repl in _REDACTIONS:
        value = pat.sub(repl, value)
    return value


def _redact(value: Any, depth: int = 0) -> Any:
    if depth > 6:
        return value
    if isinstance(value, str):
        return redact_text(value) if len(value) < 20000 else redact_text(value[:2000]) + "...[truncated]"
    if isinstance(value, dict):
        return {k: ("[REDACTED]" if k.lower() in _SENSITIVE_KEYS else _redact(v, depth + 1)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_redact(v, depth + 1) for v in value]
    return value


def redaction_processor(_logger, _name, event_dict: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for k, v in event_dict.items():
        if k in ("timestamp", "level", "logger"):
            out[k] = v
        elif k.lower() in _SENSITIVE_KEYS:
            out[k] = "[REDACTED]"
        else:
            out[k] = _redact(v)
    return out


def add_context(_logger, _name, event_dict: dict[str, Any]) -> dict[str, Any]:
    cid = correlation_id_var.get()
    if cid and "correlation_id" not in event_dict:
        event_dict["correlation_id"] = cid
    case = case_id_var.get()
    if case and "case_id" not in event_dict:
        event_dict["case_id"] = case
    return event_dict


_configured = False


def configure_logging(level: str = "INFO") -> None:
    global _configured
    if _configured:
        return
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=getattr(logging, level.upper(), logging.INFO))
    for noisy in ("httpx", "httpcore", "botocore", "urllib3", "aiosqlite", "openai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            add_context,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            redaction_processor,
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, level.upper(), logging.INFO)),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
    _configured = True


def get_logger(name: str = "rg"):
    return structlog.get_logger(name)


def setup_otel(app) -> bool:
    """Optional OpenTelemetry instrumentation (OTEL_ENABLED=true + packages installed)."""
    from .config import get_settings

    s = get_settings()
    if not s.otel_enabled:
        return False
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        get_logger().warning("otel.unavailable", hint="pip install opentelemetry-sdk opentelemetry-instrumentation-fastapi opentelemetry-exporter-otlp")
        return False
    provider = TracerProvider(resource=Resource.create({"service.name": "revenueguard-api"}))
    exporter = OTLPSpanExporter(endpoint=s.otel_exporter_otlp_endpoint or None)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    FastAPIInstrumentor.instrument_app(app)
    return True
