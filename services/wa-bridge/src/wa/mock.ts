import crypto from 'node:crypto'
import type { Logger } from 'pino'
import QRCode from 'qrcode'
import { ConnectionStateMachine } from '../state-machine.js'
import type { ConnState, ConnectorHooks, InboundDelete, InboundEdit, InboundMessage, Me, WaConnector } from './types.js'

/**
 * WA_MOCK=true: simulates a WhatsApp session for demos and tests (zero network, zero phone).
 * start(): disconnected -> connecting -> qr (real PNG of a fake pairing string) -> open after
 * autoConnectMs (0 = stay on QR until POST /mock/scan). Sends are recorded, never transmitted.
 */
export class MockConnector implements WaConnector {
  readonly mode = 'mock' as const
  private sm: ConnectionStateMachine
  private qr: string | undefined
  private meInfo: Me | undefined
  private timer: NodeJS.Timeout | undefined
  readonly sent: { jid: string; text: string; messageId: string }[] = []
  /** injected messages by id, so edit/delete/resend can refer to them */
  private readonly injected = new Map<string, InboundMessage>()

  constructor(
    private readonly hooks: ConnectorHooks,
    private readonly log: Logger,
    private readonly autoConnectMs: number,
  ) {
    this.sm = new ConnectionStateMachine((from, to) => this.log.info({ from, to, mock: true }, 'wa connection state'))
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

  private set(to: ConnState, info?: { me?: Me; reason?: string }): void {
    const before = this.sm.state
    if (this.sm.transition(to) && !(to === 'qr' && before === 'qr')) this.hooks.onState(to, info)
  }

  async start(): Promise<void> {
    if (this.sm.state !== 'disconnected') return
    this.set('connecting')
    const pairing = `MOCK-RG@${crypto.randomBytes(8).toString('hex')},demo`
    this.qr = await QRCode.toDataURL(pairing, { type: 'image/png', margin: 1, width: 320 })
    this.set('qr')
    this.hooks.onQr(this.qr)
    if (this.autoConnectMs > 0) this.timer = setTimeout(() => this.scan(), this.autoConnectMs)
  }

  /** Simulate the phone scanning the QR. */
  scan(): boolean {
    if (this.sm.state !== 'qr') return false
    this.qr = undefined
    this.meInfo = { id: '919000000001@s.whatsapp.net', name: 'RevenueGuard Demo' }
    this.set('open', { me: this.meInfo })
    // demo chat list for the chat picker (names + times only)
    const now = Math.floor(Date.now() / 1000)
    this.hooks.onChats?.([
      { jid: '120363000000000001@g.us', name: 'Dispatch & Ops', is_group: true, last_message_at: now - 300 },
      { jid: '919800000002@s.whatsapp.net', name: 'Ops Team', is_group: false, last_message_at: now - 900 },
      { jid: '120363000000000002@g.us', name: 'Family', is_group: true, last_message_at: now - 3600 },
      { jid: '120363000000000010@g.us', name: 'Hyderabad Traders Association', is_group: true, kind: 'community', members: 240, last_message_at: now - 7200 },
      { jid: '120363000000000011@g.us', name: 'Hyderabad Traders Association', is_group: true, kind: 'announcement', parent: '120363000000000010@g.us', members: 240, last_message_at: now - 7200 },
      { jid: '120363000000000012@newsletter', name: 'GST Council Updates', kind: 'channel', last_message_at: now - 10800 },
    ])
    return true
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer)
    this.set('disconnected', { reason: 'stopped' })
  }

  /** Simulate the phone unlinking the device: no auto-reconnect, mirrors loggedOut. */
  async logout(): Promise<void> {
    clearTimeout(this.timer)
    this.meInfo = undefined
    this.set('disconnected', { reason: 'logged_out' })
  }

  async relink(): Promise<void> {
    await this.logout()
    await this.start()
  }

  async sendText(jid: string, text: string): Promise<{ messageId: string }> {
    if (this.sm.state !== 'open') throw new Error('not_connected')
    const messageId = `MOCK${crypto.randomBytes(8).toString('hex').toUpperCase()}`
    this.sent.push({ jid, text, messageId })
    return { messageId }
  }

  /** Inject a demo inbound message as if it arrived from WhatsApp. */
  inject(msg: Omit<InboundMessage, 'live' | 'id' | 'ts'> & { id?: string; ts?: number }): InboundMessage {
    const full: InboundMessage = {
      id: msg.id ?? newId(),
      ts: msg.ts ?? Math.floor(Date.now() / 1000),
      chat_id: msg.chat_id,
      from: msg.from,
      from_name: msg.from_name,
      ...(msg.text ? { text: msg.text } : {}),
      ...(msg.media ? { media: msg.media } : {}),
      ...(msg.is_forwarded ? { is_forwarded: true } : {}),
      ...(msg.quoted_id ? { quoted_id: msg.quoted_id } : {}),
      live: true,
    }
    this.injected.set(full.id, full)
    this.hooks.onMessage(full)
    return full
  }

  /**
   * Simulate the sender editing an earlier message. chat_id/from default to the original injected
   * message; they are required when the original was not injected through this mock.
   */
  injectEdit(e: { id: string; text: string; chat_id?: string; from?: string; ts?: number }): InboundEdit {
    const orig = this.injected.get(e.id)
    const chat_id = e.chat_id ?? orig?.chat_id
    const from = e.from ?? orig?.from
    if (!chat_id || !from) throw new Error('unknown_message')
    const edit: InboundEdit = { id: e.id, chat_id, from, from_name: orig?.from_name ?? null, ts: e.ts ?? Math.floor(Date.now() / 1000), text: e.text, live: true }
    if (orig) this.injected.set(e.id, { ...orig, text: e.text })
    this.hooks.onEdit?.(edit)
    return edit
  }

  /** Simulate "delete for everyone" of an earlier message. */
  injectDelete(d: { id: string; chat_id?: string; from?: string; ts?: number }): InboundDelete {
    const orig = this.injected.get(d.id)
    const chat_id = d.chat_id ?? orig?.chat_id
    const from = d.from ?? orig?.from
    if (!chat_id || !from) throw new Error('unknown_message')
    const del: InboundDelete = { id: d.id, chat_id, from, ts: d.ts ?? Math.floor(Date.now() / 1000), live: true }
    this.hooks.onDelete?.(del)
    return del
  }

  /**
   * Simulate a resend: the same content (text and/or media bytes, so the same sha256) arriving again
   * under a NEW message id, optionally marked forwarded, in the same or another chat.
   */
  resend(r: { id: string; new_id?: string; chat_id?: string; from?: string; from_name?: string | null; forwarded?: boolean; ts?: number }): InboundMessage {
    const orig = this.injected.get(r.id)
    if (!orig) throw new Error('unknown_message')
    return this.inject({
      id: r.new_id,
      ts: r.ts,
      chat_id: r.chat_id ?? orig.chat_id,
      from: r.from ?? orig.from,
      from_name: r.from_name !== undefined ? r.from_name : orig.from_name,
      ...(orig.text ? { text: orig.text } : {}),
      ...(orig.media ? { media: { ...orig.media } } : {}),
      ...(r.forwarded ?? true ? { is_forwarded: true } : {}),
      ...(orig.quoted_id ? { quoted_id: orig.quoted_id } : {}),
    })
  }
}

function newId(): string {
  return `MOCKIN${crypto.randomBytes(6).toString('hex').toUpperCase()}`
}
