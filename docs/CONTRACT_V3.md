# CONTRACT V3: Agentic timeline, message lifecycle, Sarvam voice (16 Oct 2026)

Sai's rule: real/live mode must be agent-driven (LLM + tools + memory). Regex is demo-only stand-in. Code never "decides" meaning; code VERIFIES what the agent decided. If no model is available, the message waits as `pending_read` and is retried (never regex in live mode).

## 1. Timeline agent (services/api, owner: v3-timeline)
New scoped subagent `timeline` (5th agent, beside Triage/Evidence/Investigation/Resolution), defined in services/api/app/orchestrator (builtin) AND services/harness/src/agents/definitions.ts (harness), with tools from services/api/app/tools/registry.py:
- `read_chat_memory(chat_key)`; `search_cases(query|po_ref|customer)`; `read_case_timeline(case_ref)` -> every evidence node in time order incl. status (active|edited|deleted|duplicate|superseded), version history, read_by, challan_number, qty;
- `whatsapp_search(chat_key, text, since)`; `sheets_read_delivery(po_ref)`;
- write tools: `write_chat_memory(chat_key, patch)` (active_po, open_questions, pending, summary <= 600 chars; untrusted sender text stays wrapped), `propose_timeline(case_ref, decision)`.

Runs on EVERY accepted inbound message and on every lifecycle event (edit/delete/resend). Output `TimelineDecision` (pydantic, strict JSON):
```
{ "link": {"action": "existing_case"|"new_case"|"ask_which_po"|"not_business", "case_ref": str|null, "po_ref": str|null, "why": str},
  "meaning": "delivery"|"extra_delivery"|"correction"|"duplicate"|"edit"|"retraction"|"payment"|"order"|"question"|"noise",
  "delivered": {"total": number|null, "events": [{"node_id": str, "qty": number, "role": "counts"|"replaced"|"duplicate_of:<node_id>"|"ignored", "why": str}]},
  "memory_patch": {...}, "confidence": 0..1, "explanation_for_owner": str (plain simple English, 1-2 lines) }
```
Code verifier (services/api/app/timeline_verify.py, deterministic, the doc's validator role):
1. every node_id exists, belongs to the tenant, and is not `deleted` when role=counts;
2. every qty is grounded in that node's own text/derived_text/fields (reuse extraction.ground logic);
3. `total == sum(qty where role=counts)` exactly;
4. linked case/PO exists (or action=new_case with a PO grounded in the message);
5. confidence >= 0.7.
Any failure -> case goes to "Needs a check" with the agent's explanation + the failed check in plain words. Passed decisions update the Facts (delivered total) and the case; GST, duplicate-invoice, approval hash/expiry stay in existing code. Agent steps + tool calls + `why` are emitted as agent events so Agent activity shows them.
The current static rules (challan sum/dedupe, ambiguous-chat ask) become: (a) demo-mode builtin stand-in, and (b) test oracles in the eval. Not the live path.

## 2. Message lifecycle (wa-bridge owner: v3-wabridge; API side owner: v3-timeline)
wa-bridge emits new event types on POST /internal/wa-events (HMAC as today, same allowlist gate):
```
{ "type": "message_edit",   "edit":   { "id": <original msg id>, "chat_id", "from", "ts", "text": <new text> } }
{ "type": "message_delete", "delete": { "id": <original msg id>, "chat_id", "from", "ts" } }
```
Sources: Baileys `messages.update` (update.message?.editedMessage / protocolMessage type MESSAGE_EDIT, field editedMessage) and protocolMessage type REVOKE (key.id = deleted msg), also `messages.upsert` carrying protocolMessage. Media messages gain `media.sha256` (base64 of Baileys fileSha256) and the bridge also sends `forwarded: bool` (contextInfo.isForwarded) and `quoted_id` (contextInfo.stanzaId) for every message.

API handling (v3-timeline):
- edit: keep the old version in `fields.versions[]` (text, ts), set node excerpt/text to new text, `fields.status="edited"`, bump evidence_version, re-read with LLM (context), re-run timeline agent. If the case is already approved -> approval expires (existing rule). If already invoiced -> "Needs a check: message edited after billing" (never auto-change an invoice).
- delete: `fields.status="deleted"` (keep content for audit, hidden from facts), re-run timeline; same billed rule.
- resend/duplicate: exact media sha256 OR perceptual hash (imagehash phash, distance <= 6) of an image already in that chat/case within 30 days, OR same text + same quoted/forwarded within 10 min -> new node stored with `fields.status="duplicate"`, `duplicate_of`; the timeline agent is told and must not count it (verifier rule: role=counts on a duplicate fails). A re-photographed challan with the SAME challan number is also a duplicate candidate the agent decides on.
- Edits/deletes arriving before the original (out of order) are kept pending for 10 min then applied.
- `quoted_id` is passed to the agent ("this replies to message X") for linking.

## 3. Voice: Sarvam first (owner: v3-voice)
services/api/app/llm/stt_sarvam.py + LLMRouter.transcribe order: Sarvam -> NIM omni -> Groq Whisper (last, guarded) -> mock (demo only).
- POST https://api.sarvam.ai/speech-to-text, header `api-subscription-key`, multipart `file`, `model` (config SARVAM_STT_MODEL default `saaras:v3`), `mode` (SARVAM_STT_MODE default `codemix`; for v3), `language_code=unknown`. Optional `keyterms` only with saaras:v4 (PO numbers, customer + item names from the case/chat memory).
- REST limit 30 s: audio longer than 29 s is cut into <=29 s chunks with ffmpeg (opus/ogg ok) and joined.
- Returns (text, provider="sarvam", meta {language_code, model, mode}). Store `read_by` + language on the node.
- Whisper guard: temperature 0, prompt with case keyterms, reject output if it is a known hallucination ("Thank you for watching", repeated n-grams, text far longer than audio would allow ~ >4 words/sec) -> treat as unread (pending_read), never invent.
- Config: SARVAM_API_KEY, SARVAM_STT_MODEL, SARVAM_STT_MODE in config.py + .env.example + README + health check (/settings connectors/AI health shows Sarvam).
- Empty / low-language-probability transcript -> node `unread_audio` (existing audit path), case "Needs a check: couldn't hear the voice note".

## 4. Frontend (owner: v3-frontend, apps/web)
API additions in case summary (`GET /cases/{ref}` business summary) by v3-timeline:
- `timeline`: [{node_id, at, kind, source_label, text, status: active|edited|deleted|duplicate|superseded, versions:[{text, at}], duplicate_of, read_by, language, challan_number, qty, role, why}]
- `timeline_decision`: {meaning, delivered_total, explanation_for_owner, confidence, verified: bool, failed_checks: [str]}
- `chat_memory`: already exposed ({chat_key, label, active_po, open_questions, pending, summary, cases:[...]}).
UI: case page shows a "What happened" timeline with badges Edited (tap to see old text), Deleted (struck through, "not counted"), Duplicate ("same photo sent again, not counted"), Read by (e.g. "Sarvam · Hindi"), the agent's explanation + "Verified" or the failed check; a Chat memory card; Agent activity shows Timeline agent steps with tool calls and why. Demo mock data updated so Demo mode shows all of these.
