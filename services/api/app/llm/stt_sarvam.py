"""Speech-to-text helpers: Sarvam AI (first choice for Indian languages / Hinglish), audio chunking with
ffmpeg, and the Whisper hallucination guard used when Groq Whisper is the last live provider.

Sarvam REST: POST https://api.sarvam.ai/speech-to-text
  header  api-subscription-key: <key>
  form    file, model (saaras:v3 | saaras:v4), mode (v3 only: transcribe|translate|verbatim|translit|codemix),
          language_code ('unknown' = auto-detect), keyterms (JSON array string, saaras:v4 only)
  reply   {request_id, transcript, language_code, language_probability?}
The REST endpoint accepts < 30 s of audio, so longer clips are cut into <= 29 s chunks and joined.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from collections import Counter
from typing import Any

import httpx

SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text"
SARVAM_MAX_CHUNK_SECONDS = 29.0
SARVAM_V3_MODES = {"transcribe", "translate", "verbatim", "translit", "codemix"}


class SarvamError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class TranscriptRejected(Exception):
    """A provider returned text we do not trust (e.g. a Whisper hallucination). Treat the audio as unread."""


# --------------------------------------------------------------------------- ffmpeg helpers

def _ext(filename: str, mime: str) -> str:
    ext = os.path.splitext(filename or "")[1].lower()
    if ext:
        return ext
    m = (mime or "").lower()
    for k, v in (("ogg", ".ogg"), ("opus", ".ogg"), ("mpeg", ".mp3"), ("mp3", ".mp3"), ("wav", ".wav"),
                 ("webm", ".webm"), ("mp4", ".m4a"), ("aac", ".aac"), ("flac", ".flac"), ("amr", ".amr")):
        if k in m:
            return v
    return ".bin"


def ffmpeg_available() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def audio_duration(audio: bytes, filename: str = "audio", mime: str = "") -> float | None:
    """Duration in seconds via ffprobe; None if it cannot be measured."""
    if not shutil.which("ffprobe"):
        return None
    with tempfile.TemporaryDirectory(prefix="rgstt-") as d:
        p = os.path.join(d, "in" + _ext(filename, mime))
        with open(p, "wb") as f:
            f.write(audio)
        try:
            r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                "-of", "default=noprint_wrappers=1:nokey=1", p],
                               capture_output=True, text=True, timeout=30)
            val = float((r.stdout or "").strip().splitlines()[0])
            return val if val > 0 else None
        except Exception:  # noqa: BLE001
            return None


def split_audio(audio: bytes, filename: str, mime: str, max_seconds: float = SARVAM_MAX_CHUNK_SECONDS) -> list[tuple[bytes, str, str]]:
    """Cut audio into <= max_seconds chunks (16 kHz mono WAV). Returns [(bytes, filename, mime)].
    Audio that is already short enough (or cannot be measured) is returned unchanged as one chunk."""
    dur = audio_duration(audio, filename, mime)
    if dur is None or dur <= max_seconds or not shutil.which("ffmpeg"):
        return [(audio, filename, mime)]
    with tempfile.TemporaryDirectory(prefix="rgstt-") as d:
        src = os.path.join(d, "in" + _ext(filename, mime))
        with open(src, "wb") as f:
            f.write(audio)
        pattern = os.path.join(d, "chunk%03d.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-f", "segment", "-segment_time", str(max_seconds),
                        "-reset_timestamps", "1", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", pattern],
                       check=True, capture_output=True, timeout=120)
        out = []
        base = os.path.splitext(os.path.basename(filename or "audio"))[0]
        for i, name in enumerate(sorted(n for n in os.listdir(d) if n.startswith("chunk"))):
            with open(os.path.join(d, name), "rb") as f:
                data = f.read()
            if len(data) > 1024:  # skip empty tail segments (wav header only)
                out.append((data, f"{base}_part{i + 1}.wav", "audio/wav"))
        return out or [(audio, filename, mime)]


# --------------------------------------------------------------------------- Sarvam

async def _sarvam_one(client: httpx.AsyncClient, data: bytes, filename: str, mime: str, form: dict[str, str], api_key: str) -> dict[str, Any]:
    r = await client.post(SARVAM_STT_URL, headers={"api-subscription-key": api_key},
                          data=form, files={"file": (filename, data, mime or "application/octet-stream")})
    if r.status_code >= 400:
        raise SarvamError(f"sarvam http {r.status_code}: {r.text[:200]}", status=r.status_code)
    try:
        body = r.json()
    except ValueError as e:
        raise SarvamError(f"sarvam returned non-JSON: {r.text[:120]}") from e
    if not isinstance(body, dict) or "transcript" not in body:
        raise SarvamError(f"sarvam response missing transcript: {str(body)[:120]}")
    return body


async def sarvam_transcribe(
    audio: bytes,
    filename: str,
    mime: str,
    *,
    api_key: str,
    model: str = "saaras:v3",
    mode: str = "codemix",
    keyterms: list[str] | None = None,
    timeout: float = 45.0,
    language_code: str = "unknown",
) -> dict[str, Any]:
    """Transcribe with Sarvam; chunks audio longer than 29 s. Returns
    {text, provider, model, mode, language_code, language_probability, chunks, request_ids}."""
    if not api_key:
        raise SarvamError("no SARVAM_API_KEY")
    form: dict[str, str] = {"model": model, "language_code": language_code}
    if model.startswith("saaras:v3") and mode:
        if mode not in SARVAM_V3_MODES:
            raise SarvamError(f"invalid SARVAM_STT_MODE {mode!r}")
        form["mode"] = mode
    terms = [t.strip() for t in (keyterms or []) if t and t.strip()]
    if terms and model.startswith("saaras:v4"):
        form["keyterms"] = json.dumps(terms[:50], ensure_ascii=False)

    chunks = split_audio(audio, filename, mime)
    texts: list[str] = []
    langs: Counter[str] = Counter()
    probs: list[float] = []
    req_ids: list[str] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        for data, name, cmime in chunks:
            body = await _sarvam_one(client, data, name, cmime, form, api_key)
            t = (body.get("transcript") or "").strip()
            if t:
                texts.append(t)
            if body.get("language_code"):
                langs[str(body["language_code"])] += max(len(t), 1)
            if isinstance(body.get("language_probability"), (int, float)):
                probs.append(float(body["language_probability"]))
            if body.get("request_id"):
                req_ids.append(str(body["request_id"]))
    return {
        "text": " ".join(texts).strip(),
        "provider": "sarvam",
        "model": model,
        "mode": form.get("mode"),
        "language_code": langs.most_common(1)[0][0] if langs else None,
        "language_probability": round(min(probs), 4) if probs else None,
        "chunks": len(chunks),
        "request_ids": req_ids,
    }


# --------------------------------------------------------------------------- Whisper guard

KNOWN_HALLUCINATIONS = (
    "thank you for watching", "thanks for watching", "subtitles by", "subtitled by", "subtitles made by",
    "transcribed by", "please subscribe", "like and subscribe", "don't forget to subscribe", "amara.org",
    "www.mooji.org", "see you in the next video", "translated by", "captions by",
)
MAX_WORDS_PER_SECOND = 4.0


def whisper_prompt(keyterms: list[str] | None) -> str:
    base = "Business voice note from India, may be Hindi, English or Hinglish. Purchase orders, quantities, invoices."
    terms = [t.strip() for t in (keyterms or []) if t and t.strip()]
    if terms:
        base += " Terms: " + ", ".join(terms[:30]) + "."
    return base[:800]


def hallucination_reason(text: str, duration_s: float | None) -> str | None:
    """Return why a Whisper transcript looks invented, or None if it looks fine."""
    t = (text or "").strip()
    if not t:
        return "empty"
    low = t.lower()
    for phrase in KNOWN_HALLUCINATIONS:
        if phrase in low:
            return f"known hallucination phrase: {phrase!r}"
    words = re.findall(r"\w+", low)
    if duration_s and duration_s > 0 and len(words) > max(MAX_WORDS_PER_SECOND * duration_s, 6):
        return f"{len(words)} words for {duration_s:.1f}s of audio"
    if len(words) >= 8:
        for n in (1, 2, 3, 4):
            grams = [" ".join(words[i:i + n]) for i in range(len(words) - n + 1)]
            if not grams:
                continue
            gram, count = Counter(grams).most_common(1)[0]
            if count >= 4 and count * n >= 0.5 * len(words):
                return f"repeated n-gram {gram!r} x{count}"
    return None
