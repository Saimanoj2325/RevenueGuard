# wa-bridge — WhatsApp connector (Baileys)

Node 22 + TypeScript service (port **3001**) that links one WhatsApp account via WhatsApp Web, stores
messages locally for the `whatsapp_search` tool, forwards new messages (with media) to the API, and sends
approved messages for the API's Action Gateway. Implements the "WA bridge" section of `docs/CONTRACT.md` and
"wa-bridge (internal)" of `docs/CONTRACT_V2.md` (chat allowlist, chat picker, team-only sends, WhatsApp approval replies).

> Baileys is an **unofficial** WhatsApp Web client (see design doc §7/§10). Use a test number; review
> WhatsApp terms and account risk before production. The official WhatsApp Business Platform is the long-term path.

Library: npm **`baileys@7.0.0-rc14`** (WhiskeySockets/Baileys; the package was renamed from
`@whiskeysockets/baileys`; `latest` dist-tag is the v7 RC line, ESM-only). APIs used: `makeWASocket`,
`useMultiFileAuthState`, `fetchLatestBaileysVersion`, `Browsers`, `DisconnectReason`, `downloadMediaMessage`,
`normalizeMessageContent`, `getContentType`, `jidNormalizedUser`, `isJidGroup`, LID alt fields `remoteJidAlt`/`participantAlt`.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | – | `{ok, mode, state, uptime_s, messages_stored, allowlisted_chats, dropped_not_allowlisted}` |
| GET | `/status` | – | `{state:"disconnected\|qr\|connecting\|open", me?:{id,name}}` |
| GET | `/qr` | – | `{qr:"data:image/png;base64,..."\|null, state}` (PNG via `qrcode`) |
| GET | `/messages/search?q=&chat=&since=&limit=` | optional HMAC (`WA_REQUIRE_HMAC_ON_GET=true`) | local sqlite search; every word of `q` must match text / sender name / filename; `since` = unix s, unix ms or ISO. Inbound rows only from chats on the allowlist **now**; our own outbound rows always |
| POST | `/send` | **HMAC** | **customer messages** (Action Gateway, approved): `{to, text, idempotency_key, approval_id}` → `{ok, message_id}` |
| GET | `/chats?limit=` | **HMAC** | chat picker: `[{jid, name, is_group, last_message_at}]` (names + times only, never bodies), newest first |
| GET | `/allowlist` | **HMAC** | `{jids:[...]}` |
| PUT | `/allowlist` | **HMAC** | `{jids:[...]}` replaces the list (phones / `c.us` / device suffixes normalised) → `{ok, jids}` |
| POST | `/send-internal` | **HMAC** | **team-only** messages: `{to, text, approval?:{id, token, expires_at}}` → `{ok, message_id}`; 403 `recipient_not_allowlisted`, 429 `rate_limited`, 503 `not_connected` |
| POST | `/connect` | HMAC | start pairing when disconnected; `{relink:true}` wipes `/data/auth` and shows a fresh QR |
| POST | `/mock/inject` | HMAC, mock only | inject a demo inbound message `{text?, media?:{mime,filename,base64}, chat_id?, from?, from_name?, id?, ts?}` |
| POST | `/mock/scan`, `/mock/logout` | HMAC, mock only | simulate QR scan / phone unlinking |
| GET | `/mock/sent` | mock only | messages "sent" in mock mode |

Events pushed to `POST {API_URL}/internal/wa-events` (HMAC-signed):
`{type:"qr", qr, ts}`, `{type:"connection", state, me?, reason?, ts}`,
`{type:"message", message:{id, chat_id, from, from_name, ts, text?, media?:{mime, filename, base64, size}}}`.
Media above `WA_MAX_MEDIA_BYTES` is sent as `{mime, filename, size, truncated:true}` without base64.

### Chat allowlist (privacy)
- Allowed JIDs live in the same sqlite file (`allowlist` table). **Default = empty = every inbound message is dropped.**
- The gate runs first: in the Baileys connector before the message body is read or media is downloaded, and again
  in `Bridge.handleInbound` (mock path). A dropped message is never written to sqlite or `/data/media`, never
  logged (only a count, at most once a minute: `{dropped, dropped_total}`) and never forwarded to the API.
- Groups match on the group JID only (an allowlisted person writing in a non-allowlisted group is dropped);
  1:1 chats match on the chat JID or its phone-JID alias (LID-addressed chats).
- `/chats` metadata comes from Baileys `messaging-history.set`, `chats.*`, `contacts.*`, `groups.*` and
  `groupFetchAllParticipating()` on connect, plus the name/time of gated messages. It holds names and timestamps, never content.
- Removing a chat hides its old rows from `/messages/search` and stops any pending re-forward.
- **Demo:** with `WA_MOCK=true` or `DEMO_MODE=true`, a never-configured allowlist is seeded once with
  `WA_DEMO_ALLOWED_JIDS` (default `120363000000000001@g.us` "Dispatch & Ops" + `919800000002@s.whatsapp.net`,
  the `/mock/inject` default). After any `PUT /allowlist` (even `[]`) it is never re-seeded. Mock mode also lists demo chats in `/chats` after scan.

### Team-only messages + WhatsApp approvals
- `/send-internal` is for receipts ("Got it ✓ Added to PO-184 (Example Customer)"), "Which PO is this for?",
  approval prompts ("Reply 1 to Approve, 2 to Reject, 3 for proof") and the digest. The recipient **must be an
  allowlisted chat**, so a customer cannot be reached this way; customer messages stay on `/send` (gateway approval +
  idempotency). Both share one rate limiter (one WhatsApp account). Internal messages are not written to the search store.
- With `approval:{id, token, expires_at}` (unix s/ms or ISO; must be a 1:1 phone chat and not yet expired) the bridge
  saves `phone → {approval_id, token, expires_at}` (sqlite `pending_approvals`, newest prompt per phone wins).
- When that phone replies `1`/`2`/`3` (or `approve`/`reject`/`proof`) in its **allowlisted 1:1 chat**, the bridge posts
  `POST {API_URL}/internal/wa-approval-reply {phone:"+<digits>", approval_id, choice:"approve"|"reject"|"proof", token}`
  (HMAC, one attempt) and sends the API's `reply` (or `text`/`message`) back to the sender. The reply is a control
  message: it is not stored or forwarded as a wa-event. `approve`/`reject` (or any 4xx) end the prompt; `proof` keeps it open.
- Expired locally: the API is not called; the sender gets "This approval has expired. Please use the latest approval message."
- Replies in groups, from other phones, or from a chat that is not allowlisted never reach the API.
  **Approver phones must be on the allowlist** for their replies to be read.

### Behaviour
- **HMAC** exactly as the contract: `X-RG-Signature: sha256=<hex HMAC-SHA256(raw body)>`, `X-RG-Timestamp` unix seconds,
  rejected if skew > 300 s (`HMAC_MAX_SKEW_SEC`). Same scheme as `services/api/app/security.py`.
- **Connection state machine** `disconnected → connecting → qr → open`, `open → connecting` on drop; invalid transitions are logged and ignored.
- **Auth** multi-file state in `/data/auth` (`WA_AUTH_DIR`) — mount `/data` as a volume.
- **Reconnect** exponential backoff with jitter (`WA_RECONNECT_BASE_MS`=1000 → cap `WA_RECONNECT_MAX_MS`=60000), immediate on
  `restartRequired` (515, normal after pairing). **No reconnect on `loggedOut` (401)**: credentials are wiped, state
  `disconnected`, a `connection` event with `reason:"logged_out"` is sent; re-pair via `POST /connect`.
- **Inbound**: text, extended text, image (+caption), document (+caption, original filename), audio/voice notes
  (`audio/ogg; codecs=opus`). Group sender = participant; LID senders resolved to phone JIDs when Baileys provides
  the alt JID. History-sync (`append`) messages are stored for search but not forwarded as live events. Own/status/broadcast skipped.
- **Store-then-forward**: messages land in sqlite first (`/data/wa-bridge.sqlite`), media files in `/data/media`;
  a retry loop (`WA_FORWARD_RETRY_MS`=30 s) re-forwards anything the API did not acknowledge (API down/restart).
- **/send idempotency**: the key is claimed atomically in sqlite *before* sending. A repeat key → **409**
  `{error:"duplicate_idempotency_key", status, message_id}`. If the send throws, the outcome is unknown
  (it may have reached WhatsApp), so the key stays burned as `failed` → the gateway must verify and use a new key.
  Rate-limited sends (429) release the claim (nothing was sent).
- **Rate limit**: token bucket `WA_SEND_RATE_PER_MIN`=20 plus `WA_SEND_MIN_INTERVAL_MS`=1500 spacing → 429 + `retry-after`.
- **Logs** (pino JSON): every phone number / JID is reduced to its last 4 digits (`***3210@s.whatsapp.net`),
  message text, QR and base64 are replaced by `[redacted:<len>]`; Baileys' own logs go through the same redaction.
- **MOCK mode** (`WA_MOCK=true`): no network; generates a real QR PNG of a fake pairing string, auto-"scans" after
  `WA_MOCK_AUTO_CONNECT_MS` (default 1500; 0 = wait for `/mock/scan`), records sends, and lets the API inject demo
  messages through `/mock/inject` — they go through the same store + forward path as real ones.

## Env

`PORT`(3001) `API_URL`(http://api:8000) `INTERNAL_HMAC_SECRET` `WA_MOCK` `WA_MOCK_AUTO_CONNECT_MS` `WA_DATA_DIR`(/data)
`WA_AUTH_DIR` `WA_DB_PATH` `WA_MEDIA_DIR` `WA_MAX_MEDIA_BYTES`(16 MB) `WA_SEND_RATE_PER_MIN` `WA_SEND_MIN_INTERVAL_MS`
`WA_RECONNECT_BASE_MS` `WA_RECONNECT_MAX_MS` `WA_FORWARD_RETRY_MS` `WA_REQUIRE_HMAC_ON_GET` `WA_BROWSER_NAME` `LOG_LEVEL` `BAILEYS_LOG_LEVEL`(warn)
`DEMO_MODE` `WA_DEMO_ALLOWED_JIDS` `WA_APPROVAL_REPLY_TIMEOUT_MS`(15000, max wait for the limiter before answering an approver)

## Run

```bash
npm ci && npm run build && npm test
WA_MOCK=true INTERNAL_HMAC_SECRET=dev API_URL=http://localhost:8000 WA_DATA_DIR=./data npm start
# real WhatsApp: WA_MOCK=false, open GET /qr (or the web app's connector page) and scan with WhatsApp → Linked devices
docker build -t revenueguard/wa-bridge . && docker run -p 3001:3001 -v wa-data:/data -e INTERNAL_HMAC_SECRET=dev revenueguard/wa-bridge
```

Sign a request for manual testing: `services/harness/scripts/sign.mjs '<body>'` prints the two headers.

## Layout
`src/index.ts` boot · `src/server.ts` Fastify routes · `src/bridge.ts` store→forward glue · `src/wa/baileys.ts` real
connector · `src/wa/mock.ts` mock connector · `src/state-machine.ts` states + backoff · `src/store.ts` sqlite
(messages, idempotency, allowlist, chat names, pending approvals) · `src/hmac.ts` · `src/logger.ts` redaction · `src/rate-limit.ts` · `tests/` vitest.
