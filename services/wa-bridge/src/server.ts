import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { z } from 'zod'
import { Bridge, SendError } from './bridge.js'
import { SIG_HEADER, TS_HEADER, verifySignature } from './hmac.js'
import { parseSince } from './store.js'
import { MockConnector } from './wa/mock.js'
import { toJid } from './wa/types.js'

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer
  }
}

const SendBody = z.object({
  to: z.string().min(3),
  text: z.string().min(1).max(4096),
  idempotency_key: z.string().min(8).max(200),
  approval_id: z.string().min(1).max(200),
})

const AllowlistBody = z.object({ jids: z.array(z.string().min(3).max(200)).max(1000) })

const SendInternalBody = z.object({
  to: z.string().min(3).max(200),
  text: z.string().min(1).max(4096),
  /** present on approval prompts: the bridge maps the recipient phone -> this token for the "1/2/3" reply */
  approval: z
    .object({
      id: z.string().min(1).max(200),
      token: z.string().min(8).max(2000),
      expires_at: z.union([z.number(), z.string().min(1)]),
    })
    .optional(),
})

const InjectBody = z.object({
  id: z.string().optional(),
  chat_id: z.string().default('919800000002@s.whatsapp.net'),
  from: z.string().default('919800000002@s.whatsapp.net'),
  from_name: z.string().nullable().default('Ops Team'),
  ts: z.number().optional(),
  text: z.string().optional(),
  media: z.object({ mime: z.string(), filename: z.string(), base64: z.string(), sha256: z.string().optional() }).optional(),
  forwarded: z.boolean().optional(),
  quoted_id: z.string().optional(),
})
const MockEditBody = z.object({ id: z.string().min(1), text: z.string().min(1), chat_id: z.string().optional(), from: z.string().optional(), ts: z.number().optional() })
const MockDeleteBody = z.object({ id: z.string().min(1), chat_id: z.string().optional(), from: z.string().optional(), ts: z.number().optional() })
const MockResendBody = z.object({
  id: z.string().min(1),
  new_id: z.string().optional(),
  chat_id: z.string().optional(),
  from: z.string().optional(),
  from_name: z.string().nullable().optional(),
  forwarded: z.boolean().optional(),
  ts: z.number().optional(),
})

export function buildServer(bridge: Bridge): FastifyInstance {
  const { cfg, store, log } = bridge
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 })
  const limiter = bridge.limiter
  const startedAt = Date.now()

  // keep the raw body for HMAC verification
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer
    if ((body as Buffer).length === 0) return done(null, {})
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')))
    } catch {
      const err = new Error('invalid_json') as Error & { statusCode: number }
      err.statusCode = 400
      done(err, undefined)
    }
  })

  const requireHmac = async (req: FastifyRequest, reply: FastifyReply) => {
    const v = verifySignature(
      req.rawBody ?? Buffer.alloc(0),
      req.headers[SIG_HEADER] as string | undefined,
      req.headers[TS_HEADER] as string | undefined,
      cfg.hmacSecret,
      cfg.hmacMaxSkewSec,
    )
    if (!v.ok) {
      log.warn({ path: req.url, reason: v.reason }, 'hmac rejected')
      return reply.code(401).send({ ok: false, error: 'unauthorized', reason: v.reason })
    }
  }

  app.get('/health', async () => ({
    ok: true,
    service: 'wa-bridge',
    mode: bridge.connector.mode,
    state: bridge.connector.state(),
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    messages_stored: store.count(),
    allowlisted_chats: bridge.getAllowlist().length,
    dropped_not_allowlisted: bridge.droppedTotal,
  }))

  app.get('/status', async () => {
    const me = bridge.connector.me()
    return { state: bridge.connector.state(), ...(me && bridge.connector.state() === 'open' ? { me } : {}) }
  })

  app.get('/qr', async () => ({ qr: bridge.connector.qrDataUrl() ?? null, state: bridge.connector.state() }))

  app.get('/messages/search', { preHandler: cfg.requireHmacOnGet ? requireHmac : undefined }, async (req) => {
    const q = req.query as Record<string, string | undefined>
    // only chats that are on the allowlist NOW (rows stored before a chat was removed stay hidden)
    const messages = store.search({ q: q.q, chat: q.chat, since: parseSince(q.since), limit: q.limit ? Number(q.limit) : undefined, chats: bridge.getAllowlist() })
    return {
      messages: messages.map((m) => ({
        id: m.id,
        chat_id: m.chat_id,
        from: m.from,
        from_name: m.from_name,
        ts: m.ts,
        direction: m.direction,
        text: m.text,
        ...(m.edited_at ? { edited_at: m.edited_at } : {}),
        ...(m.media_mime ? { media: { mime: m.media_mime, filename: m.media_filename, size: m.media_size } } : {}),
      })),
    }
  })

  app.post('/send', { preHandler: requireHmac }, async (req, reply) => {
    const parsed = SendBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_body', issues: parsed.error.issues })
    const { to, text, idempotency_key, approval_id } = parsed.data
    let jid: string
    try {
      jid = toJid(to)
    } catch {
      return reply.code(400).send({ ok: false, error: 'invalid_recipient' })
    }
    if (bridge.connector.state() !== 'open') return reply.code(503).send({ ok: false, error: 'not_connected', state: bridge.connector.state() })

    const claim = store.claimIdempotency({ key: idempotency_key, approval_id, to_jid: jid, payload_hash: Bridge.payloadHash(jid, text) })
    if (!claim.claimed) {
      log.warn({ key: idempotency_key, status: claim.existing.status }, 'refused repeated idempotency key')
      return reply.code(409).send({ ok: false, error: 'duplicate_idempotency_key', status: claim.existing.status, message_id: claim.existing.message_id })
    }
    const wait = limiter.tryAcquire()
    if (wait > 0) {
      // release the claim: nothing was sent, the gateway may retry with the same key
      store.db.prepare('DELETE FROM idempotency WHERE key = ? AND status = ?').run(idempotency_key, 'pending')
      return reply.code(429).header('retry-after', Math.ceil(wait / 1000)).send({ ok: false, error: 'rate_limited', retry_after_ms: wait })
    }
    try {
      const { messageId } = await bridge.connector.sendText(jid, text)
      store.completeIdempotency(idempotency_key, 'sent', messageId)
      store.upsertMessage({
        id: messageId, chat_id: jid, from: bridge.connector.me()?.id ?? 'me', from_name: bridge.connector.me()?.name ?? null,
        ts: Math.floor(Date.now() / 1000), text, direction: 'out', media_mime: null, media_filename: null, media_path: null, media_size: null, forwarded: true,
      })
      log.info({ to: jid, approval_id, message_id: messageId }, 'message sent')
      return { ok: true, message_id: messageId }
    } catch (err) {
      // Outcome unknown (may have reached WhatsApp) -> key stays burned as 'failed'; gateway must verify before retrying with a new key.
      store.completeIdempotency(idempotency_key, 'failed', null, (err as Error).message)
      log.error({ err: (err as Error).message, to: jid }, 'send failed')
      return reply.code(502).send({ ok: false, error: 'send_failed', detail: (err as Error).message })
    }
  })

  // ---------- chat picker + allowlist (HMAC: only the API calls these) ----------
  app.get('/chats', { preHandler: requireHmac }, async (req) => {
    const q = req.query as Record<string, string | undefined>
    // names + last message time only; never message bodies
    return store.listChats(q.limit ? Number(q.limit) : undefined)
  })

  app.get('/allowlist', { preHandler: requireHmac }, async () => ({ jids: bridge.getAllowlist() }))

  app.put('/allowlist', { preHandler: requireHmac }, async (req, reply) => {
    const parsed = AllowlistBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_body', issues: parsed.error.issues })
    try {
      return { ok: true, jids: bridge.setAllowlist(parsed.data.jids) }
    } catch {
      return reply.code(400).send({ ok: false, error: 'invalid_jid' })
    }
  })

  // Team-only messages. Customer messages must use /send (Action Gateway approval + idempotency).
  app.post('/send-internal', { preHandler: requireHmac }, async (req, reply) => {
    const parsed = SendInternalBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_body', issues: parsed.error.issues })
    const { to, text, approval } = parsed.data
    let appr: { id: string; token: string; expires_at: number } | undefined
    if (approval) {
      const exp = parseSince(String(approval.expires_at))
      if (exp === undefined) return reply.code(400).send({ ok: false, error: 'invalid_approval', detail: 'bad expires_at' })
      appr = { id: approval.id, token: approval.token, expires_at: exp }
    }
    try {
      const { messageId } = await bridge.sendInternal(to, text, appr)
      return { ok: true, message_id: messageId }
    } catch (err) {
      if (err instanceof SendError) {
        if (err.code === 'rate_limited' && err.retryAfterMs) reply.header('retry-after', Math.ceil(err.retryAfterMs / 1000))
        return reply.code(err.status).send({
          ok: false,
          error: err.code,
          ...(err.retryAfterMs ? { retry_after_ms: err.retryAfterMs } : {}),
          ...(err.message !== err.code ? { detail: err.message } : {}),
          ...(err.code === 'not_connected' ? { state: bridge.connector.state() } : {}),
        })
      }
      throw err
    }
  })

  // Gateway read-check before (re)sending: what happened to this idempotency key? HMAC: only the API calls it.
  app.post('/idempotency/lookup', { preHandler: requireHmac }, async (req, reply) => {
    const key = (req.body as { idempotency_key?: unknown } | undefined)?.idempotency_key
    if (typeof key !== 'string' || key.length < 8 || key.length > 200) return reply.code(400).send({ ok: false, error: 'invalid_body' })
    const row = store.db.prepare('SELECT key, status, message_id, error, created_at FROM idempotency WHERE key = ?').get(key) as
      | { key: string; status: string; message_id: string | null; error: string | null; created_at: number }
      | undefined
    if (!row) return reply.code(404).send({ ok: true, found: false })
    return { ok: true, found: true, status: row.status, message_id: row.message_id, error: row.error, created_at: row.created_at }
  })

  // Re-pair: drop credentials and show a fresh QR (after loggedOut). HMAC: only the API may trigger it.
  app.post('/connect', { preHandler: requireHmac }, async (req) => {
    const relink = (req.body as { relink?: boolean } | undefined)?.relink === true
    if (relink || bridge.connector.state() === 'disconnected') {
      if (relink) await bridge.connector.relink()
      else await bridge.connector.start()
    }
    return { ok: true, state: bridge.connector.state() }
  })

  if (bridge.connector instanceof MockConnector) {
    const mock = bridge.connector
    app.post('/mock/inject', { preHandler: requireHmac }, async (req, reply) => {
      const parsed = InjectBody.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_body', issues: parsed.error.issues })
      const b = parsed.data
      if (!b.text && !b.media) return reply.code(400).send({ ok: false, error: 'text_or_media_required' })
      const msg = mock.inject({
        id: b.id, ts: b.ts, chat_id: b.chat_id, from: b.from, from_name: b.from_name, text: b.text,
        media: b.media ? { mime: b.media.mime, filename: b.media.filename, data: Buffer.from(b.media.base64, 'base64'), ...(b.media.sha256 ? { sha256: b.media.sha256 } : {}) } : undefined,
        is_forwarded: b.forwarded, quoted_id: b.quoted_id,
      })
      return { ok: true, id: msg.id }
    })
    // CONTRACT_V3 §2 lifecycle simulation: edit / delete-for-everyone / resend of an injected message
    app.post('/mock/edit', { preHandler: requireHmac }, async (req, reply) => {
      const parsed = MockEditBody.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_body', issues: parsed.error.issues })
      try {
        return { ok: true, id: mock.injectEdit(parsed.data).id }
      } catch {
        return reply.code(404).send({ ok: false, error: 'unknown_message' })
      }
    })
    app.post('/mock/delete', { preHandler: requireHmac }, async (req, reply) => {
      const parsed = MockDeleteBody.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_body', issues: parsed.error.issues })
      try {
        return { ok: true, id: mock.injectDelete(parsed.data).id }
      } catch {
        return reply.code(404).send({ ok: false, error: 'unknown_message' })
      }
    })
    app.post('/mock/resend', { preHandler: requireHmac }, async (req, reply) => {
      const parsed = MockResendBody.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_body', issues: parsed.error.issues })
      try {
        return { ok: true, id: mock.resend(parsed.data).id }
      } catch {
        return reply.code(404).send({ ok: false, error: 'unknown_message' })
      }
    })
    app.post('/mock/scan', { preHandler: requireHmac }, async () => ({ ok: mock.scan(), state: mock.state() }))
    app.post('/mock/logout', { preHandler: requireHmac }, async () => {
      await mock.logout()
      return { ok: true, state: mock.state() }
    })
    app.get('/mock/sent', async () => ({ sent: mock.sent }))
  }

  return app
}
