import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from 'pino'
import type { ApiClient, ApprovalChoice, WaEvent, WaMessagePayload } from './api-client.js'
import type { Config } from './config.js'
import { SendRateLimiter } from './rate-limit.js'
import type { LifecycleEvent, Store, StoredMessage } from './store.js'
import { isGroupJid, normalizeJid, phoneOf, toJid, type ConnectorHooks, type InboundDelete, type InboundEdit, type InboundEnvelope, type InboundMessage, type WaConnector } from './wa/types.js'

const CHOICES: Record<string, ApprovalChoice> = { '1': 'approve', '2': 'reject', '3': 'proof', approve: 'approve', reject: 'reject', proof: 'proof' }

/** "1" / " 2. " / "Approve" / "reject!" -> choice; anything else -> null (treated as a normal message). */
export function parseApprovalChoice(text: string | undefined): ApprovalChoice | null {
  if (!text) return null
  const t = text.trim().toLowerCase().replace(/[.!\s]+$/, '')
  return CHOICES[t] ?? null
}

export const APPROVAL_EXPIRED_TEXT = 'This approval has expired. Please use the latest approval message.'
export const APPROVAL_FAILED_TEXT = 'Sorry, your reply could not be recorded. Please open the Approvals page in RevenueGuard.'

export class SendError extends Error {
  constructor(readonly code: 'invalid_recipient' | 'recipient_not_allowlisted' | 'not_connected' | 'rate_limited' | 'send_failed' | 'invalid_approval', readonly status: number, readonly retryAfterMs?: number, detail?: string) {
    super(detail ?? code)
  }
}

/**
 * Glue between the connector, the sqlite store and the API: allowlist gate first, then store, then forward.
 * Messages from chats that are not on the allowlist are dropped before anything is written, logged or forwarded.
 */
export class Bridge {
  connector!: WaConnector
  /** One limiter for the one WhatsApp account: /send, /send-internal and approval answers share it. */
  readonly limiter: SendRateLimiter
  private retryTimer: NodeJS.Timeout | undefined
  private forwarding = new Set<string>()
  private allowed = new Set<string>()
  droppedTotal = 0
  private droppedSinceLog = 0
  private lastDropLog = 0

  constructor(
    readonly cfg: Config,
    readonly store: Store,
    readonly api: ApiClient,
    readonly log: Logger,
  ) {
    this.limiter = new SendRateLimiter(cfg.sendRatePerMinute, cfg.sendMinIntervalMs)
    // Default = empty = drop everything. Demo/mock: seed the demo dispatch chats once, only if never configured.
    if (!store.allowlistInitialized() && (cfg.mock || cfg.demoMode) && cfg.demoAllowedJids.length) {
      store.setAllowlist(cfg.demoAllowedJids.map(normalizeJid))
      log.info({ count: cfg.demoAllowedJids.length }, 'demo mode: seeded chat allowlist with demo chats')
    }
    this.allowed = new Set(store.getAllowlist())
  }

  // ---------- allowlist ----------

  getAllowlist(): string[] {
    return [...this.allowed].sort()
  }

  /** Replace the allowlist. Throws on an unparseable JID. */
  setAllowlist(jids: string[]): string[] {
    const list = [...new Set(jids.map(normalizeJid))]
    const saved = this.store.setAllowlist(list)
    this.allowed = new Set(saved)
    this.log.info({ count: saved.length }, 'chat allowlist updated')
    return saved
  }

  /** Group chats match on the group JID only; 1:1 chats match on the chat JID or its phone-JID alias (LID chats). */
  isAllowed(chatId: string, alt?: string): boolean {
    if (this.allowed.size === 0) return false
    let c: string
    try {
      c = normalizeJid(chatId)
    } catch {
      return false
    }
    if (this.allowed.has(c)) return true
    if (isGroupJid(c) || !alt) return false
    try {
      return this.allowed.has(normalizeJid(alt))
    } catch {
      return false
    }
  }

  /** Privacy gate: record picker metadata (name + time only), then allow or drop. Never sees message content. */
  admit(env: InboundEnvelope): boolean {
    try {
      const jid = normalizeJid(env.chat_id)
      // time only on the chat row; a 1:1 sender's profile name goes to contacts so it never hides the saved name
      this.store.upsertChat({ jid, is_group: env.is_group, last_message_at: env.ts })
      if (!env.is_group) {
        const alt = env.chat_alt ? normalizeJid(env.chat_alt) : undefined
        if (alt && alt !== jid) this.store.linkLid(jid, alt)
        if (env.push_name) this.store.upsertContact(jid, null, env.push_name)
      }
    } catch {
      /* bad jid: still apply the gate below */
    }
    if (this.isAllowed(env.chat_id, env.chat_alt)) return true
    this.droppedTotal++
    this.droppedSinceLog++
    const now = Date.now()
    if (now - this.lastDropLog >= 60_000) {
      this.log.info({ dropped: this.droppedSinceLog, dropped_total: this.droppedTotal }, 'dropped messages from chats not on the allowlist')
      this.droppedSinceLog = 0
      this.lastDropLog = now
    }
    return false
  }

  hooks(): ConnectorHooks {
    return {
      onState: (state, info) => {
        void this.api.postEvent({ type: 'connection', state, ...(info?.me ? { me: info.me } : {}), ...(info?.reason ? { reason: info.reason } : {}), ts: Date.now() / 1000 })
      },
      onQr: (qr) => {
        void this.api.postEvent({ type: 'qr', qr, ts: Date.now() / 1000 })
      },
      onMessage: (m) => {
        void this.handleInbound(m)
      },
      onEdit: (e) => {
        void this.handleEdit(e)
      },
      onDelete: (d) => {
        void this.handleDelete(d)
      },
      admit: (env) => this.admit(env),
      onChats: (chats) => {
        for (const c of chats) {
          try {
            this.store.upsertChat({ ...c, jid: normalizeJid(c.jid), is_group: c.is_group ?? isGroupJid(c.jid) })
          } catch {
            /* ignore unparseable jid */
          }
        }
      },
      onContacts: (contacts) => {
        for (const c of contacts) {
          try {
            const jid = normalizeJid(c.jid)
            this.store.upsertContact(jid, c.name ?? null, c.push ?? null)
            if (c.phone_jid) this.store.linkLid(jid, normalizeJid(c.phone_jid))
          } catch {
            /* ignore */
          }
        }
      },
    }
  }

  async handleInbound(m: InboundMessage): Promise<void> {
    const group = isGroupJid(m.chat_id)
    // 1) allowlist gate BEFORE any write/log/forward (the Baileys connector already gated before media download)
    if (!this.admit({ chat_id: m.chat_id, chat_alt: group ? undefined : m.from, is_group: group, push_name: m.from_name, ts: m.ts })) return
    // 2) approval replies ("1"/"2"/"3") from a 1:1 chat with a pending prompt are control messages, not evidence
    if (!group && m.live && (await this.tryApprovalReply(m))) return
    let mediaPath: string | null = null
    if (m.media && m.media.data.length > 0) {
      fs.mkdirSync(this.cfg.mediaDir, { recursive: true })
      mediaPath = path.join(this.cfg.mediaDir, `${safe(m.id)}-${safe(m.media.filename)}`)
      fs.writeFileSync(mediaPath, m.media.data)
    }
    const inserted = this.store.upsertMessage({
      id: m.id,
      chat_id: m.chat_id,
      from: m.from,
      from_name: m.from_name,
      ts: m.ts,
      text: m.text ?? null,
      direction: 'in',
      media_mime: m.media?.mime ?? null,
      media_filename: m.media?.filename ?? null,
      media_path: mediaPath,
      media_size: m.media ? m.media.data.length : null,
      forwarded: !m.live, // history sync is searchable locally but not pushed as live events
      is_forwarded: !!m.is_forwarded,
      quoted_id: m.quoted_id ?? null,
      media_sha256: m.media ? (m.media.sha256 ?? (m.media.data.length > 0 ? sha256b64(m.media.data) : null)) : null,
    })
    if (!inserted) {
      this.log.debug({ id: m.id }, 'duplicate inbound message ignored')
      return
    }
    this.log.info({ id: m.id, chat: m.chat_id, hasMedia: !!m.media, live: m.live }, 'inbound message stored')
    if (m.live) await this.forward(this.store.get(m.id), m)
  }

  /** Edit of an earlier message: same privacy gate as messages, recorded once, forwarded as message_edit. */
  async handleEdit(e: InboundEdit): Promise<void> {
    await this.handleLifecycle('edit', e.id, e.chat_id, e.from, e.from_name ?? null, e.ts, e.live, e.text)
  }

  /** Delete-for-everyone of an earlier message: forwarded as message_delete. */
  async handleDelete(d: InboundDelete): Promise<void> {
    await this.handleLifecycle('delete', d.id, d.chat_id, d.from, null, d.ts, d.live)
  }

  private async handleLifecycle(kind: 'edit' | 'delete', id: string, chatId: string, from: string, fromName: string | null, ts: number, live: boolean, text?: string): Promise<void> {
    const group = isGroupJid(chatId)
    if (!this.admit({ chat_id: chatId, chat_alt: group ? undefined : from, is_group: group, push_name: fromName, ts })) return
    if (kind === 'edit' && !text) return
    const ev = this.store.recordLifecycle({ kind, msg_id: id, chat_id: chatId, from, ts, text: text ?? null, forwarded: !live })
    if (!ev) {
      this.log.debug({ id, kind }, 'duplicate message lifecycle event ignored')
      return
    }
    this.log.info({ id, chat: chatId, kind, live }, `message ${kind} recorded`)
    if (live) await this.forwardLifecycle(ev)
  }

  private lifecycleEvent(e: LifecycleEvent): WaEvent {
    const base = { id: e.msg_id, chat_id: e.chat_id, from: e.from, ts: e.ts }
    return e.kind === 'edit' ? { type: 'message_edit', edit: { ...base, text: e.text ?? '' } } : { type: 'message_delete', delete: base }
  }

  private async forwardLifecycle(e: LifecycleEvent): Promise<void> {
    const key = `lc:${e.seq}`
    if (this.forwarding.has(key)) return
    this.forwarding.add(key)
    try {
      if (await this.api.postEvent(this.lifecycleEvent(e))) this.store.markLifecycleForwarded(e.seq)
    } finally {
      this.forwarding.delete(key)
    }
  }

  private toPayload(s: StoredMessage, live?: InboundMessage): WaMessagePayload {
    const payload: WaMessagePayload = { id: s.id, chat_id: s.chat_id, from: s.from, from_name: s.from_name, ts: s.ts, forwarded: s.is_forwarded, quoted_id: s.quoted_id }
    if (s.text) payload.text = s.text
    if (s.media_mime && s.media_filename) {
      let data: Buffer | undefined = live?.media?.data
      if ((!data || data.length === 0) && s.media_path && fs.existsSync(s.media_path)) data = fs.readFileSync(s.media_path)
      if (data && data.length > 0 && data.length <= this.cfg.maxMediaBytes) {
        payload.media = { mime: s.media_mime, filename: s.media_filename, base64: data.toString('base64'), size: data.length }
      } else {
        payload.media = { mime: s.media_mime, filename: s.media_filename, size: data?.length ?? 0, truncated: true }
      }
      if (s.media_sha256) payload.media.sha256 = s.media_sha256
    }
    return payload
  }

  private async forward(s: StoredMessage | null, live?: InboundMessage): Promise<void> {
    if (!s || this.forwarding.has(s.id)) return
    this.forwarding.add(s.id)
    try {
      const ok = await this.api.postEvent({ type: 'message', message: this.toPayload(s, live) })
      if (ok) this.store.markForwarded(s.id)
    } finally {
      this.forwarding.delete(s.id)
    }
  }

  /** Periodically re-forward messages the API did not acknowledge (API down, restarts). */
  startRetryLoop(): void {
    this.retryTimer = setInterval(() => {
      for (const s of this.store.unforwarded(20)) {
        if (this.isAllowed(s.chat_id, s.from)) void this.forward(s)
        else this.store.markForwarded(s.id) // chat was removed from the allowlist: never forward it
      }
      for (const e of this.store.unforwardedLifecycle(20)) {
        if (this.isAllowed(e.chat_id, e.from)) void this.forwardLifecycle(e)
        else this.store.markLifecycleForwarded(e.seq)
      }
    }, this.cfg.forwardRetryIntervalMs)
    this.retryTimer.unref()
  }

  stop(): void {
    clearInterval(this.retryTimer)
  }

  // ---------- team-only messages + WhatsApp approvals ----------

  /**
   * Team-only message (receipts, "Which PO?", approval prompts, digest). Recipient must be an allowlisted
   * (watched) chat, so customer messages cannot take this path: they go through /send (gateway-approved).
   */
  async sendInternal(to: string, text: string, approval?: { id: string; token: string; expires_at: number }): Promise<{ messageId: string; jid: string }> {
    let jid: string
    try {
      jid = normalizeJid(toJid(to))
    } catch {
      throw new SendError('invalid_recipient', 400)
    }
    if (!this.isAllowed(jid)) throw new SendError('recipient_not_allowlisted', 403)
    const phone = approval ? phoneOf(jid) : null
    if (approval) {
      if (!phone) throw new SendError('invalid_approval', 400, undefined, 'approval prompts go to a 1:1 phone chat')
      if (approval.expires_at <= Math.floor(Date.now() / 1000)) throw new SendError('invalid_approval', 400, undefined, 'approval already expired')
    }
    if (this.connector.state() !== 'open') throw new SendError('not_connected', 503)
    const wait = this.limiter.tryAcquire()
    if (wait > 0) throw new SendError('rate_limited', 429, wait)
    let messageId: string
    try {
      ;({ messageId } = await this.connector.sendText(jid, text))
    } catch (err) {
      throw new SendError('send_failed', 502, undefined, (err as Error).message)
    }
    if (approval && phone) this.store.setPendingApproval({ phone, approval_id: approval.id, token: approval.token, expires_at: approval.expires_at })
    this.log.info({ to: jid, message_id: messageId, approval_id: approval?.id }, 'internal message sent')
    return { messageId, jid }
  }

  /** Returns true when the message was consumed as an approval reply. */
  private async tryApprovalReply(m: InboundMessage): Promise<boolean> {
    const choice = parseApprovalChoice(m.text)
    if (!choice || m.media) return false
    const phone = phoneOf(m.from) ?? phoneOf(m.chat_id)
    if (!phone) return false
    const pending = this.store.getPendingApproval(phone)
    if (!pending) return false
    const replyJid = isGroupJid(m.chat_id) ? null : m.chat_id
    if (pending.expires_at <= Math.floor(Date.now() / 1000)) {
      this.store.deletePendingApproval(phone, pending.approval_id)
      this.log.info({ approval_id: pending.approval_id }, 'approval reply after expiry')
      if (replyJid) await this.replyTo(replyJid, APPROVAL_EXPIRED_TEXT)
      return true
    }
    const res = await this.api.postApprovalReply({ phone: `+${phone}`, approval_id: pending.approval_id, choice, token: pending.token })
    this.log.info({ approval_id: pending.approval_id, choice, status: res.status }, 'approval reply forwarded')
    // approve/reject consume the prompt; "proof" keeps it so the approver can answer 1/2 next. A 4xx (expired, used, not an approver) ends it too.
    if ((res.ok && choice !== 'proof') || (res.status >= 400 && res.status < 500)) this.store.deletePendingApproval(phone, pending.approval_id)
    const text = res.reply ?? (res.ok ? null : APPROVAL_FAILED_TEXT)
    if (text && replyJid) await this.replyTo(replyJid, text)
    return true
  }

  /** Answer an approver, waiting (bounded) for the shared send limiter. */
  private async replyTo(jid: string, text: string): Promise<void> {
    const deadline = Date.now() + this.cfg.approvalReplyTimeoutMs
    for (;;) {
      if (this.connector.state() !== 'open') return void this.log.warn('approval answer not sent: not connected')
      const wait = this.limiter.tryAcquire()
      if (wait === 0) break
      if (Date.now() + wait > deadline) return void this.log.warn({ wait }, 'approval answer not sent: rate limited')
      await new Promise((r) => setTimeout(r, wait))
    }
    try {
      await this.connector.sendText(jid, text)
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'approval answer send failed')
    }
  }

  static payloadHash(to: string, text: string): string {
    return crypto.createHash('sha256').update(`${to}\n${text}`).digest('hex')
  }
}

function sha256b64(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('base64')
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}
