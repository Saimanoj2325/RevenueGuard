"""Voice: Sarvam first (CONTRACT_V3 §3). httpx is mocked with MockTransport; no network."""
from __future__ import annotations

import json
import shutil
import subprocess

import httpx
import pytest

from app.config import get_settings
from app.llm import stt_sarvam
from app.llm.router import LLMRouter, LLMUnavailable

needs_ffmpeg = pytest.mark.skipif(not stt_sarvam.ffmpeg_available(), reason="ffmpeg/ffprobe not installed")


def _sine(seconds: float) -> bytes:
    r = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
                        "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"], capture_output=True, check=True)
    return r.stdout


@pytest.fixture
def settings(monkeypatch):
    s = get_settings()
    for k, v in {"sarvam_api_key": "sk-test", "sarvam_stt_model": "saaras:v3", "sarvam_stt_mode": "codemix",
                 "nvidia_api_key": "", "groq_api_key": "", "demo_mode": True}.items():
        monkeypatch.setattr(s, k, v)
    return s


def _mock_http(monkeypatch, handler):
    calls: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request, len(calls))

    real = httpx.AsyncClient

    def factory(*a, **kw):
        kw["transport"] = httpx.MockTransport(wrapped)
        return real(*a, **kw)

    monkeypatch.setattr(stt_sarvam.httpx, "AsyncClient", factory)
    return calls


def _form(req: httpx.Request) -> bytes:
    return req.read()


async def test_sarvam_success(monkeypatch, settings):
    def handler(req, n):
        assert str(req.url) == stt_sarvam.SARVAM_STT_URL
        assert req.headers["api-subscription-key"] == "sk-test"
        body = _form(req)
        assert b'name="model"' in body and b"saaras:v3" in body
        assert b'name="mode"' in body and b"codemix" in body
        assert b'name="language_code"' in body and b"unknown" in body
        assert b'name="keyterms"' not in body  # v3 never sends keyterms
        return httpx.Response(200, json={"request_id": "r1", "transcript": "PO-184 ka 60 piece deliver ho gaya",
                                         "language_code": "hi-IN", "language_probability": 0.91})

    calls = _mock_http(monkeypatch, handler)
    events = []

    async def fake_emit(tenant_id, kind, **kw):
        events.append((kind, kw))

    monkeypatch.setattr("app.llm.router.emit", fake_emit)
    llm = LLMRouter()
    text, provider = await llm.transcribe(b"OggS-fake", "vn.ogg", "audio/ogg", "SIDE CAR", tenant_id="t1", case_id="c1",
                                          keyterms=["PO-184"])
    assert (text, provider) == ("PO-184 ka 60 piece deliver ho gaya", "sarvam")
    assert len(calls) == 1
    assert llm.last_stt_meta["language_code"] == "hi-IN" and llm.last_stt_meta["model"] == "saaras:v3"
    assert events and events[0][0] == "llm.provider" and events[0][1]["provider"] == "sarvam"
    ex = await llm.transcribe_ex(b"OggS-fake", "vn.ogg", "audio/ogg")
    assert set(ex) >= {"text", "provider", "model", "language_code", "language_probability"}
    assert ex["language_probability"] == 0.91


async def test_sarvam_v4_sends_keyterms(monkeypatch, settings):
    monkeypatch.setattr(settings, "sarvam_stt_model", "saaras:v4")

    def handler(req, n):
        body = _form(req)
        assert b'name="keyterms"' in body and json.dumps(["PO-184", "Model X"]).encode() in body
        assert b'name="mode"' not in body
        return httpx.Response(200, json={"request_id": "r", "transcript": "ok", "language_code": "en-IN"})

    _mock_http(monkeypatch, handler)
    text, provider = await LLMRouter().transcribe(b"x", "a.wav", "audio/wav", None, keyterms=["PO-184", "Model X"])
    assert (text, provider) == ("ok", "sarvam")


@needs_ffmpeg
async def test_sarvam_chunks_long_audio(monkeypatch, settings):
    audio = _sine(65)
    assert 64 < stt_sarvam.audio_duration(audio, "long.wav", "audio/wav") < 66
    chunks = stt_sarvam.split_audio(audio, "long.wav", "audio/wav")
    assert len(chunks) == 3
    for data, _name, mime in chunks:
        d = stt_sarvam.audio_duration(data, "c.wav", mime)
        assert d is not None and d <= 29.5

    def handler(req, n):
        return httpx.Response(200, json={"request_id": f"r{n}", "transcript": f"part{n}", "language_code": "en-IN",
                                         "language_probability": 0.8 + n / 100})

    calls = _mock_http(monkeypatch, handler)
    llm = LLMRouter()
    text, provider = await llm.transcribe(audio, "long.wav", "audio/wav", None)
    assert provider == "sarvam" and text == "part1 part2 part3"
    assert len(calls) == 3
    assert llm.last_stt_meta["chunks"] == 3 and llm.last_stt_meta["language_probability"] == 0.81


@pytest.mark.parametrize("status", [429, 500])
async def test_sarvam_error_falls_back_to_next_provider(monkeypatch, settings, status):
    monkeypatch.setattr(settings, "groq_api_key", "gsk-test")
    _mock_http(monkeypatch, lambda req, n: httpx.Response(status, json={"error": "busy"}))

    async def fake_whisper(self, audio, filename, mime, prompt):
        assert "PO-184" in prompt  # keyterms reach the whisper prompt
        return "Correction: 70 delivered", "en"

    monkeypatch.setattr(LLMRouter, "_groq_whisper", fake_whisper)
    monkeypatch.setattr(stt_sarvam, "audio_duration", lambda *a, **k: 4.0)
    llm = LLMRouter()
    text, provider = await llm.transcribe(b"x", "a.ogg", "audio/ogg", "SIDECAR", keyterms=["PO-184"])
    assert (text, provider) == ("Correction: 70 delivered", "groq")
    assert str(status) in llm.ai_health()["sarvam"]["last_error"]


async def test_sarvam_error_demo_mock_only_in_demo(monkeypatch, settings):
    _mock_http(monkeypatch, lambda req, n: httpx.Response(500))
    text, provider = await LLMRouter().transcribe(b"x", "a.ogg", "audio/ogg", "SIDECAR")
    assert (text, provider) == ("SIDECAR", "mock")
    monkeypatch.setattr(settings, "demo_mode", False)
    with pytest.raises(LLMUnavailable):
        await LLMRouter().transcribe(b"x", "a.ogg", "audio/ogg", "SIDECAR")


@pytest.mark.parametrize("whisper_text,duration", [
    ("Thank you for watching!", 5.0),
    ("Subtitles by the Amara.org community", 5.0),
    ("okay okay okay okay okay okay okay okay okay okay", 30.0),
    ("seventy pieces of model x were delivered to the customer yesterday evening and the invoice should go out", 2.0),
])
async def test_whisper_hallucination_rejected(monkeypatch, settings, whisper_text, duration):
    monkeypatch.setattr(settings, "sarvam_api_key", "")
    monkeypatch.setattr(settings, "groq_api_key", "gsk-test")

    async def fake_whisper(self, audio, filename, mime, prompt):
        return whisper_text, "en"

    monkeypatch.setattr(LLMRouter, "_groq_whisper", fake_whisper)
    monkeypatch.setattr(stt_sarvam, "audio_duration", lambda *a, **k: duration)
    with pytest.raises(LLMUnavailable, match="rejected"):
        # even with a demo sidecar available, a rejected whisper read stays unread (never invented text)
        await LLMRouter().transcribe(b"x", "a.ogg", "audio/ogg", "SIDECAR")


def test_hallucination_reason_accepts_normal_text():
    assert stt_sarvam.hallucination_reason("PO 184 mein 70 piece deliver hue", 4.0) is None
    assert stt_sarvam.hallucination_reason("", 3.0) == "empty"


def test_ai_health_lists_sarvam(settings):
    h = LLMRouter().ai_health()
    assert h["sarvam"]["configured"] is True and h["sarvam"]["role"] == "stt" and h["sarvam"]["model"] == "saaras:v3"
    assert "nim" in h and "groq" in h
