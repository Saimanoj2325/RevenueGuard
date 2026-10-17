"""Multimodal router (CONTRACT §Multimodal): by mime ->
  application/pdf, image/* documents -> NIM Nemotron Parse (text/tables) then vision model field extraction
  image/* photos                     -> vision model
  audio/*                            -> Groq Whisper (fallback NIM omni)
  local fallback                     -> pypdf text layer / pytesseract OCR / fixture sidecar (DEMO_MODE)
Output is stored on an evidence node (media_object_key in MinIO + derived_text + fields).
"""
from __future__ import annotations

import io
import re
from typing import Any

from .config import get_settings
from .extraction import ExtractedFields, extract_fields, regex_extract
from .observability import get_logger
from . import storage

log = get_logger("media")

DOC_HINTS = re.compile(r"(?i)challan|invoice|po|purchase|order|bill|receipt|scan|doc|statement")


def _png_sidecar_text(data: bytes) -> str | None:
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(data))
        return (img.info or {}).get("rg_text")
    except Exception:  # noqa: BLE001
        return None


def _ocr(data: bytes) -> str | None:
    try:
        import pytesseract
        from PIL import Image

        return pytesseract.image_to_string(Image.open(io.BytesIO(data)))
    except Exception as e:  # noqa: BLE001
        log.info("media.ocr_unavailable", error=str(e)[:120])
        return None


def _pdf_text(data: bytes) -> str | None:
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        text = "\n".join((p.extract_text() or "") for p in reader.pages[:20])
        return text.strip() or None
    except Exception as e:  # noqa: BLE001
        log.info("media.pdf_text_failed", error=str(e)[:120])
        return None


async def ingest_media(
    tenant_id: str,
    data: bytes,
    mime: str,
    filename: str,
    *,
    session=None,
    case_id: str | None = None,
    sidecar_text: str | None = None,
) -> dict[str, Any]:
    """Store the blob, derive text + fields. Returns {object_key, derived_text, fields, route, provider}."""
    from .llm.router import LLMUnavailable, get_llm

    s = get_settings()
    llm = get_llm()
    key = await storage.put_bytes(tenant_id, filename, data, mime)
    mime = (mime or "application/octet-stream").lower()
    derived: str | None = None
    route: list[str] = []
    provider = "none"
    fields: dict[str, Any] | None = None
    kw = {"session": session, "tenant_id": tenant_id, "case_id": case_id}

    if mime.startswith("audio/"):
        try:
            derived, provider = await llm.transcribe(data, filename, mime, sidecar_text, **kw)
            route.append(f"stt:{provider}")
        except LLMUnavailable as e:
            route.append(f"stt:failed:{e}")
    elif mime == "application/pdf":
        if s.nvidia_api_key:
            route.append("nemotron-parse:skipped(pdf text layer first)")
        derived = _pdf_text(data)
        route.append("pypdf" if derived else "pypdf:empty")
        provider = "pypdf"
    elif mime.startswith("image/"):
        is_doc = bool(DOC_HINTS.search(filename))
        if s.nvidia_api_key and is_doc:
            derived = await llm.nemotron_parse(data, mime)
            if derived:
                route.append("nemotron-parse")
                provider = "nim"
        if s.nvidia_api_key:
            try:
                res = await llm.vision_extract(
                    data,
                    mime,
                    "Extract order-to-cash fields from this image (delivery challan, PO, invoice or photo). "
                    + (f"Parsed text for reference:\n{derived}\n" if derived else "")
                    + "Return JSON with doc_type, po_ref, customer, item, qty_ordered, rate, amount, qty_delivered, qty_pending, is_correction, invoice_number, payment_amount.",
                    ExtractedFields,
                    lambda: regex_extract(derived or ""),
                    **kw,
                )
                fields = res.data
                provider = res.provider
                route.append(f"vision:{res.provider}")
            except LLMUnavailable as e:
                route.append(f"vision:failed:{str(e)[:80]}")
        if derived is None:
            side = _png_sidecar_text(data) if s.demo_mode else None
            if side:
                derived = side
                route.append("mock-vision:fixture-sidecar")
                provider = "mock"
            else:
                derived = _ocr(data)
                route.append("pytesseract" if derived else "pytesseract:unavailable")
                provider = "tesseract"
    else:
        try:
            derived = data.decode("utf-8")
            route.append("utf8")
        except UnicodeDecodeError:
            route.append("unsupported")

    if fields is None and derived:
        fields, meta = await extract_fields(derived, source="media", source_id=key, **kw)
        route.append(f"extract:{meta.get('provider')}")
    return {"object_key": key, "derived_text": derived, "fields": fields or {}, "route": route, "provider": provider, "mime": mime}
