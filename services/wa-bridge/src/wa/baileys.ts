import fs from 'node:fs/promises'
import type { Logger } from 'pino'
import type { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  useMultiFileAuthState,
  WAMessageStubType,
  type WAMessage,
  type WAMessageKey,
  type WAMessageUpdate,
  type WASocket,
} from 'baileys'
import { ConnectionStateMachine, backoffDelay } from '../state-machine.js'
import { isHiddenJid, kindOfJid } from './types.js'
import type { ChatMeta, ContactMeta, ConnState, ConnectorHooks, InboundMessage, Me, WaConnector } from './types.js'

const PROTOCOL_REVOKE = proto.Message.ProtocolMessage.Type.REVOKE
const PROTOCOL_MESSAGE_EDIT = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT

export interface BaileysOptions {
  authDir: string
  reconnectBaseMs: number
  reconnectMaxMs: number
  maxMediaBytes: number
  browserName: string
  baileysLogLevel: string
}

/**
 * Real WhatsApp Web session via Baileys (npm `baileys`, v7 line; WhiskeySockets/Baileys).
 * - multi-file auth state persisted in opts.authDir (mount /data/auth as a volume)
 * - reconnects with exponential backoff on every close EXCEPT loggedOut (401)
 * - restartRequired (515, normal right after QR pairing) reconnects immediately
 */
export class BaileysConnector implements WaConnector {
  readonly mode = 'baileys' as const
  private sock: WASocket | undefined
  private sm: ConnectionStateMachine
  private qr: string | undefined
  private meInfo: Me | undefined
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | undefined
  private stopped = false
  private generation = 0
  /** LIDs already looked up on this socket (cleared on reconnect) */
  private lidTried = new Set<string>()

  constructor(
    private readonly opts: BaileysOptions,
    private readonly hooks: ConnectorHooks,
    private readonly log: Logger,
  ) {
    this.sm = new ConnectionStateMachine((from, to) => this.log.info({ from, to }, 'wa connection state'))
  }

  state(): ConnState {
    return this.sm.state
  }
  me(): Me | undefined {
    return this.meInfo
  }
  qrDataUrl(): string | undefined {
    return this.sm.state === 'qr' ? this.qr : undefined
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.generation++
    try {
      this.sock?.end(undefined)
    } catch {
      /* ignore */
    }
    this.sock = undefined
    this.setState('disconnected', { reason: 'stopped' })
  }

  async relink(): Promise<void> {
    await this.stop()
    await fs.rm(this.opts.authDir, { recursive: true, force: true })
    this.meInfo = undefined
    await this.start()
  }

  async sendText(jid: string, text: string): Promise<{ messageId: string }> {
    if (!this.sock || this.sm.state !== 'open') throw new Error('not_connected')
    const sent = await this.sock.sendMessage(jid, { text })
    const id = sent?.key?.id
    if (!id) throw new Error('send_failed_no_id')
    return { messageId: id }
  }

  private setState(to: ConnState, info?: { me?: Me; reason?: string }): void {
    const before = this.sm.state
    if (to === 'disconnected' && before === 'disconnected') return
    if (!this.sm.transition(to)) {
      this.log.warn({ from: before, to }, 'ignored invalid wa state transition')
      return
    }
    if (to !== 'qr' || before !== 'qr') this.hooks.onState(to, info)
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    const gen = ++this.generation
    this.setState('connecting')
    await fs.mkdir(this.opts.authDir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir)
    let version: [number, number, number] | undefined
    try {
      const latest = await fetchLatestBaileysVersion()
      version = latest.version as [number, number, number]
    } catch {
      version = undefined // fall back to the version bundled with baileys
    }
    const baileysLog = this.log.child({ mod: 'baileys' })
    baileysLog.level = this.opts.baileysLogLevel
    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      browser: Browsers.ubuntu(this.opts.browserName),
      logger: baileysLog as never,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    })
    this.sock = sock
    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
      if (gen !== this.generation) return // stale socket
      const { connection, lastDisconnect, qr } = update
      if (qr) {
        try {
          this.qr = await QRCode.toDataURL(qr, { type: 'image/png', margin: 1, width: 320 })
          this.setState('qr')
          this.hooks.onQr(this.qr)
        } catch (err) {
          this.log.error({ err }, 'qr render failed')
        }
      }
      if (connection === 'open') {
        this.attempt = 0
        this.qr = undefined
        const u = sock.user
        this.meInfo = u ? { id: jidNormalizedUser(u.id), name: u.name ?? u.notify ?? undefined } : undefined
        this.setState('open', { me: this.meInfo })
        this.lidTried.clear()
        // chats stored by earlier sessions that still have no phone number
        setTimeout(() => gen === this.generation && this.resolveLids(this.hooks.unresolvedLids?.() ?? []), 5_000)
        // group subjects for the chat picker (names only)
        sock
          .groupFetchAllParticipating()
          .then((groups) => {
            this.emitChats(Object.values(groups).map(groupMeta))
            this.emitParticipantLinks(Object.values(groups))
          })
          .catch((err) => this.log.warn({ err: (err as Error).message }, 'group list fetch failed'))
      }
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
        this.sock = undefined
        if (statusCode === DisconnectReason.loggedOut) {
          this.log.warn('wa session logged out; credentials cleared, waiting for relink')
          this.qr = undefined
          this.meInfo = undefined
          await fs.rm(this.opts.authDir, { recursive: true, force: true }).catch(() => {})
          this.setState('disconnected', { reason: 'logged_out' })
          return // never auto-reconnect on loggedOut
        }
        if (this.stopped) return
        const immediate = statusCode === DisconnectReason.restartRequired
        const delay = immediate ? 0 : backoffDelay(this.attempt++, this.opts.reconnectBaseMs, this.opts.reconnectMaxMs)
        this.log.info({ statusCode, delay, attempt: this.attempt }, 'wa connection closed; reconnecting')
        this.setState('connecting', { reason: `closed_${statusCode ?? 'unknown'}` })
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = setTimeout(() => {
          this.connect().catch((err) => this.log.error({ err }, 'reconnect failed'))
        }, delay)
      }
    })

    // ---- chat picker metadata (names + timestamps only, never bodies) ----
    sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
      if (gen !== this.generation) return
      this.emitChats((chats ?? []).map(chatMeta))
      this.emitContacts(contacts ?? [])
      // LID -> phone links from message KEYS only (remoteJidAlt / participantAlt); bodies are never touched here
      this.emitKeyLinks((messages ?? []).map((m) => m.key))
    })
    sock.ev.on('chats.upsert', (chats) => gen === this.generation && this.emitChats(chats.map(chatMeta)))
    sock.ev.on('chats.update', (chats) => gen === this.generation && this.emitChats(chats.map(chatMeta)))
    sock.ev.on('contacts.upsert', (contacts) => gen === this.generation && this.emitContacts(contacts))
    sock.ev.on('contacts.update', (contacts) => gen === this.generation && this.emitContacts(contacts.filter((c): c is typeof c & { id: string } => !!c.id)))
    sock.ev.on('groups.upsert', (groups) => {
      if (gen !== this.generation) return
      this.emitChats(groups.map(groupMeta))
      this.emitParticipantLinks(groups)
    })
    sock.ev.on('groups.update', (groups) =>
      gen === this.generation && this.emitChats(groups.filter((g): g is typeof g & { id: string } => !!g.id).map(groupMeta)),
    )
    // LID <-> phone links, so LID-addressed 1:1 chats can show the real number instead of a LID
    sock.ev.on('lid-mapping.update', (m) => {
      if (gen !== this.generation || !m?.lid || !m?.pn) return
      this.hooks.onContacts?.([{ jid: m.lid, phone_jid: m.pn }])
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (gen === this.generation) this.emitKeyLinks(messages.map((m) => m.key))
      for (const m of messages) {
        try {
          const parsed = await this.parseMessage(sock, m, type === 'notify')
          if (parsed) this.hooks.onMessage(parsed)
        } catch (err) {
          this.log.error({ err, id: m.key?.id }, 'failed to process inbound message')
        }
      }
    })

    // edits (update.message.editedMessage) and deletes for everyone (messageStubType REVOKE)
    sock.ev.on('messages.update', (updates) => {
      if (gen !== this.generation) return
      for (const u of updates) {
        try {
          this.handleUpdate(u)
        } catch (err) {
          this.log.error({ err, id: u.key?.id }, 'failed to process message update')
        }
      }
    })
  }

  /**
   * Who sent it, from the key alone (no content read). Undefined for own / broadcast / malformed keys,
   * and when the privacy gate drops the chat.
   */
  private gate(key: WAMessageKey | null | undefined, pushName: string | null | undefined, ts: number): { chat_id: string; from: string } | undefined {
    if (!key?.id || !key.remoteJid) return undefined
    if (key.fromMe) return undefined
    if (isJidBroadcast(key.remoteJid) || key.remoteJid === 'status@broadcast') return undefined
    const k = key as typeof key & { remoteJidAlt?: string; participantAlt?: string }
    const group = !!isJidGroup(key.remoteJid)
    const fromRaw = group ? (k.participantAlt ?? key.participant ?? key.remoteJid) : (k.remoteJidAlt ?? key.remoteJid)
    if (this.hooks.admit && !this.hooks.admit({
      chat_id: key.remoteJid,
      ...(group ? {} : { chat_alt: jidNormalizedUser(fromRaw) }),
      is_group: group,
      push_name: pushName ?? null,
      ts,
    })) return undefined
    return { chat_id: key.remoteJid, from: jidNormalizedUser(fromRaw) }
  }

  /** messages.update: Baileys re-emits edits / revokes here with key.id = the ORIGINAL message id. */
  private handleUpdate(u: WAMessageUpdate): void {
    const upd = u.update ?? {}
    const edited = upd.message?.editedMessage?.message
    const revoked = upd.messageStubType === WAMessageStubType.REVOKE
    if (!edited && !revoked) return // status receipts, reactions, polls...: never gated, never read
    const ts = tsOf(upd.messageTimestamp)
    const who = this.gate(u.key, null, ts) // privacy gate BEFORE reading the new text
    if (!who || !u.key.id) return
    if (revoked) {
      this.hooks.onDelete?.({ id: u.key.id, ...who, ts, live: true })
      return
    }
    const text = textOf(edited)
    if (text) this.hooks.onEdit?.({ id: u.key.id, ...who, from_name: null, ts, text, live: true })
  }

  private emitChats(chats: ChatMeta[]): void {
    // status updates and broadcast lists are not conversations anyone can watch
    const list = chats.filter((c) => c.jid && !isJidBroadcast(c.jid) && !isHiddenJid(c.jid))
    if (!list.length) return
    this.hooks.onChats?.(list)
    this.resolveLids(list.map((c) => c.jid).filter((j) => j.endsWith('@lid')))
  }

  /** Message keys carry the phone JID next to the LID (remoteJidAlt for 1:1, participantAlt in groups). */
  private emitKeyLinks(keys: (WAMessageKey | null | undefined)[]): void {
    const out: ContactMeta[] = []
    const seen = new Set<string>()
    for (const key of keys) {
      const k = key as (WAMessageKey & { remoteJidAlt?: string; participantAlt?: string }) | null | undefined
      if (!k) continue
      const pairs: [string | null | undefined, string | null | undefined][] = [[k.remoteJid, k.remoteJidAlt], [k.participant, k.participantAlt]]
      for (const [a, b] of pairs) {
        if (!a || !b) continue
        const lid = a.endsWith('@lid') ? a : b.endsWith('@lid') ? b : undefined
        const pn = a.endsWith('@s.whatsapp.net') ? a : b.endsWith('@s.whatsapp.net') ? b : undefined
        if (lid && pn && !seen.has(lid)) { seen.add(lid); out.push({ jid: jidNormalizedUser(lid), phone_jid: jidNormalizedUser(pn) }) }
      }
    }
    if (out.length) this.hooks.onContacts?.(out)
  }

  /** Group participant lists carry `phoneNumber` next to LID ids when WhatsApp shares it. */
  private emitParticipantLinks(groups: { participants?: { id?: string; lid?: string; phoneNumber?: string }[] }[]): void {
    const out: ContactMeta[] = []
    for (const g of groups) {
      for (const p of g.participants ?? []) {
        const lid = p.lid ?? (p.id?.endsWith('@lid') ? p.id : undefined)
        const pn = p.phoneNumber ?? (p.id?.endsWith('@s.whatsapp.net') ? p.id : undefined)
        if (lid && pn) out.push({ jid: lid, phone_jid: pn })
      }
    }
    if (out.length) this.hooks.onContacts?.(out)
  }

  /** Ask Baileys' LID store (and, through it, WhatsApp) for the phone number behind LID chats; batched, best effort. */
  private resolveLids(lids: string[]): void {
    const sock = this.sock
    const store = (sock as unknown as { signalRepository?: { lidMapping?: { getPNsForLIDs?(l: string[]): Promise<{ lid: string; pn: string }[] | null>; getPNForLID?(l: string): Promise<string | null> } } })?.signalRepository?.lidMapping
    const todo = [...new Set(lids)].filter((l) => !this.lidTried.has(l))
    if (!store || !todo.length) return
    for (const l of todo) this.lidTried.add(l)
    const gen = this.generation
    void (async () => {
      for (let i = 0; i < todo.length; i += 50) {
        if (gen !== this.generation) return
        const batch = todo.slice(i, i + 50)
        try {
          let pairs: { lid: string; pn: string }[] = []
          if (store.getPNsForLIDs) pairs = (await store.getPNsForLIDs(batch)) ?? []
          else if (store.getPNForLID) for (const l of batch) { const pn = await store.getPNForLID(l); if (pn) pairs.push({ lid: l, pn }) }
          const out = pairs.filter((p) => p?.lid && p?.pn).map((p) => ({ jid: jidNormalizedUser(p.lid), phone_jid: jidNormalizedUser(p.pn) }))
          if (out.length) this.hooks.onContacts?.(out)
        } catch (err) {
          this.log.debug({ err: (err as Error).message }, 'lid -> phone lookup failed')
        }
      }
    })()
  }

  private emitContacts(contacts: { id: string; lid?: string; name?: string; notify?: string; verifiedName?: string; phoneNumber?: string }[]): void {
    const out: ContactMeta[] = []
    for (const c of contacts) {
      const name = c.name?.trim() || null
      const push = (c.verifiedName ?? c.notify)?.trim() || null
      const lid = c.lid ?? (c.id?.endsWith('@lid') ? c.id : undefined)
      const pn = c.phoneNumber ?? (c.id?.endsWith('@s.whatsapp.net') ? c.id : undefined)
      if (!name && !push && !(lid && pn)) continue
      if (c.id) out.push({ jid: c.id, name, push, phone_jid: c.id === lid ? (pn ?? null) : null })
      if (pn && pn !== c.id) out.push({ jid: pn, name, push })
      if (lid && lid !== c.id) out.push({ jid: lid, name, push, phone_jid: pn ?? null })
    }
    if (out.length) this.hooks.onContacts?.(out)
  }

  private async parseMessage(sock: WASocket, m: WAMessage, live: boolean): Promise<InboundMessage | undefined> {
    const key = m.key
    if (!key?.id || !key.remoteJid) return undefined
    if (key.fromMe) return undefined
    if (isJidBroadcast(key.remoteJid) || key.remoteJid === 'status@broadcast') return undefined
    const content = normalizeMessageContent(m.message)
    if (!content) return undefined
    const type = getContentType(content)
    if (!type || type === 'senderKeyDistributionMessage' || type === 'reactionMessage') return undefined
    const ts = tsOf(m.messageTimestamp)

    if (type === 'protocolMessage') {
      const pm = content.protocolMessage
      const kind = pm?.type === PROTOCOL_REVOKE ? 'delete' : pm?.type === PROTOCOL_MESSAGE_EDIT ? 'edit' : null
      const target = pm?.key?.id
      if (!kind || !target) return undefined // app-state keys, ephemeral settings, history sync...: ignored
      // Privacy gate BEFORE reading the edited text.
      const who = this.gate(key, m.pushName, ts)
      if (!who) return undefined
      if (kind === 'delete') {
        this.hooks.onDelete?.({ id: target, ...who, ts, live })
      } else {
        const text = textOf(pm?.editedMessage)
        const editTs = pm?.timestampMs ? Math.floor(Number(pm.timestampMs.toString()) / 1000) : ts
        if (text) this.hooks.onEdit?.({ id: target, ...who, from_name: m.pushName ?? null, ts: editTs, text, live })
      }
      return undefined
    }

    // Privacy gate BEFORE reading the body or downloading media: non-allowlisted chats are dropped here.
    const who = this.gate(key, m.pushName, ts)
    if (!who) return undefined

    let text: string | undefined
    let media: InboundMessage['media']
    let mime: string | undefined
    let filename: string | undefined

    switch (type) {
      case 'conversation':
        text = content.conversation ?? undefined
        break
      case 'extendedTextMessage':
        text = content.extendedTextMessage?.text ?? undefined
        break
      case 'imageMessage':
        text = content.imageMessage?.caption ?? undefined
        mime = content.imageMessage?.mimetype ?? 'image/jpeg'
        filename = `${key.id}.${extFor(mime)}`
        break
      case 'documentMessage':
        text = content.documentMessage?.caption ?? undefined
        mime = content.documentMessage?.mimetype ?? 'application/octet-stream'
        filename = content.documentMessage?.fileName ?? `${key.id}.${extFor(mime)}`
        break
      case 'audioMessage':
        // WhatsApp voice notes (ptt) are ogg/opus
        mime = content.audioMessage?.mimetype ?? 'audio/ogg; codecs=opus'
        filename = `${key.id}.${content.audioMessage?.ptt ? 'ogg' : extFor(mime)}`
        break
      default:
        return undefined // video, stickers, contacts, polls... not needed for evidence
    }

    const ctx = (content[type] as { contextInfo?: proto.IContextInfo | null } | null | undefined)?.contextInfo ?? undefined
    let sha256: string | undefined
    if (mime && filename) {
      const raw = content.imageMessage?.fileSha256 ?? content.documentMessage?.fileSha256 ?? content.audioMessage?.fileSha256
      sha256 = b64(raw)
      const declared = Number(
        (content.imageMessage?.fileLength ?? content.documentMessage?.fileLength ?? content.audioMessage?.fileLength ?? 0).toString(),
      )
      if (declared > this.opts.maxMediaBytes) {
        media = { mime, filename, data: Buffer.alloc(0), ...(sha256 ? { sha256 } : {}) }
      } else {
        const data = await downloadMediaMessage(m, 'buffer', {}, { logger: this.log as never, reuploadRequest: sock.updateMediaMessage })
        media = { mime, filename, data, ...(sha256 ? { sha256 } : {}) }
      }
    }
    if (!text && !media) return undefined
    return {
      id: key.id,
      chat_id: who.chat_id,
      from: who.from,
      from_name: m.pushName ?? null,
      ts,
      ...(text ? { text } : {}),
      ...(media ? { media } : {}),
      is_forwarded: !!ctx?.isForwarded,
      ...(ctx?.stanzaId ? { quoted_id: ctx.stanzaId } : {}),
      live,
    }
  }
}

function tsOf(raw: unknown): number {
  if (raw == null) return Math.floor(Date.now() / 1000)
  const n = typeof raw === 'number' ? raw : Number(String(raw))
  return Number.isFinite(n) && n > 0 ? n : Math.floor(Date.now() / 1000)
}

/** Text of a (possibly wrapped) message: conversation, extended text, or a media caption. */
export function textOf(msg: proto.IMessage | null | undefined): string | undefined {
  const c = normalizeMessageContent(msg)
  if (!c) return undefined
  const t =
    c.conversation ??
    c.extendedTextMessage?.text ??
    c.imageMessage?.caption ??
    c.documentMessage?.caption ??
    c.videoMessage?.caption ??
    undefined
  return t || undefined
}

function b64(raw: Uint8Array | string | null | undefined): string | undefined {
  if (!raw) return undefined
  if (typeof raw === 'string') return raw || undefined // already base64 (JSON-restored message)
  return raw.length ? Buffer.from(raw).toString('base64') : undefined
}

function chatMeta(c: { id?: string | null; name?: string | null; conversationTimestamp?: unknown; lastMessageRecvTimestamp?: number }): ChatMeta {
  if (!c.id) return { jid: '' } // filtered out by emitChats
  const raw = c.lastMessageRecvTimestamp ?? c.conversationTimestamp
  const ts = raw == null ? null : Number(String(raw))
  const kind = kindOfJid(c.id)
  // a 1:1 chat's `name` is the saved contact name; groups and channels carry their title
  return { jid: c.id, name: c.name ?? null, is_group: !!isJidGroup(c.id), kind: kind === 'group' ? undefined : kind, last_message_at: ts && Number.isFinite(ts) ? ts : null }
}

/** Group metadata -> picker row. Tells communities and their announcement groups apart from ordinary groups. */
function groupMeta(g: { id: string; subject?: string | null; isCommunity?: boolean; isCommunityAnnounce?: boolean; linkedParent?: string; size?: number; participants?: unknown[] }): ChatMeta {
  const known = g.isCommunity !== undefined || g.isCommunityAnnounce !== undefined || g.linkedParent !== undefined
  const kind = g.isCommunity ? 'community' : g.isCommunityAnnounce ? 'announcement' : known ? 'group' : undefined
  const members = g.size ?? (Array.isArray(g.participants) && g.participants.length ? g.participants.length : undefined)
  return { jid: g.id, name: g.subject ?? null, is_group: true, ...(kind ? { kind } : {}), ...(members ? { members } : {}), ...(g.linkedParent ? { parent: g.linkedParent } : {}) }
}

function extFor(mime: string): string {
  const base = mime.split(';')[0]!.trim()
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'text/csv': 'csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  }
  return map[base] ?? 'bin'
}
