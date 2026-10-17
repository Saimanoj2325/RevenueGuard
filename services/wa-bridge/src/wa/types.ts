export type ConnState = 'disconnected' | 'qr' | 'connecting' | 'open'

export interface Me {
  id: string
  name?: string
}

export interface InboundMedia {
  mime: string
  filename: string
  data: Buffer
  /** base64 SHA-256 of the plaintext file (Baileys fileSha256); bridge computes it from data when absent */
  sha256?: string
}

export interface InboundMessage {
  id: string
  chat_id: string
  from: string
  from_name: string | null
  ts: number
  text?: string
  media?: InboundMedia
  /** contextInfo.isForwarded */
  is_forwarded?: boolean
  /** contextInfo.stanzaId: id of the message this one replies to */
  quoted_id?: string
  /** history sync (append) messages are stored but not forwarded as live events */
  live: boolean
}

/** An edit of an earlier message (id = the ORIGINAL message id). */
export interface InboundEdit {
  id: string
  chat_id: string
  from: string
  from_name?: string | null
  ts: number
  text: string
  live: boolean
}

/** A "delete for everyone" (revoke) of an earlier message (id = the deleted message id). */
export interface InboundDelete {
  id: string
  chat_id: string
  from: string
  ts: number
  live: boolean
}

/** Connector seam: real Baileys session or the demo mock. */
export interface WaConnector {
  readonly mode: 'baileys' | 'mock'
  state(): ConnState
  me(): Me | undefined
  /** Latest QR as PNG data URL while state === 'qr'. */
  qrDataUrl(): string | undefined
  start(): Promise<void>
  stop(): Promise<void>
  /** Drop credentials and start a fresh pairing (new QR). */
  relink(): Promise<void>
  sendText(jid: string, text: string): Promise<{ messageId: string }>
}

/** Chat-picker metadata. Never carries message bodies. */
export interface ChatMeta {
  jid: string
  name?: string | null
  is_group?: boolean
  last_message_at?: number | null
}

/** What the connector knows about an inbound message BEFORE parsing/downloading it (allowlist gate). */
export interface InboundEnvelope {
  chat_id: string
  /** phone JID of the sender in a 1:1 chat when the chat is addressed by LID */
  chat_alt?: string
  is_group: boolean
  push_name?: string | null
  ts: number
}

export interface ConnectorHooks {
  onState(state: ConnState, info?: { me?: Me; reason?: string }): void
  onQr(dataUrl: string): void
  onMessage(msg: InboundMessage): void
  /** Message edited / deleted for everyone. Only called after admit() let the chat through. */
  onEdit?(edit: InboundEdit): void
  onDelete?(del: InboundDelete): void
  /**
   * Privacy gate, called before the message is parsed, its media downloaded, stored, logged or forwarded.
   * Returns false to drop it. Implementations record chat metadata (no content) and count drops.
   */
  admit?(env: InboundEnvelope): boolean
  /** Chat / contact / group names from the WhatsApp session for the chat picker. */
  onChats?(chats: ChatMeta[]): void
  onContacts?(contacts: { jid: string; name: string }[]): void
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us')
}

/** Canonical JID: lowercase, no device suffix ("91..:12@s.whatsapp.net" -> "91..@s.whatsapp.net"); bare numbers -> user JID. */
export function normalizeJid(jid: string): string {
  const t = jid.trim().toLowerCase()
  if (!t.includes('@')) return toJid(t)
  const [user, server] = t.split('@') as [string, string]
  return `${user.split(':')[0]}@${server === 'c.us' ? 's.whatsapp.net' : server}`
}

/** Phone digits of a user JID / phone string ("+91 98000-00002" | "919800000002@s.whatsapp.net" -> "919800000002"); null for groups/LIDs. */
export function phoneOf(v: string): string | null {
  const t = v.trim().toLowerCase()
  if (t.includes('@')) {
    if (!t.endsWith('@s.whatsapp.net') && !t.endsWith('@c.us')) return null
    const digits = t.split('@')[0]!.split(':')[0]!.replace(/\D/g, '')
    return digits.length >= 8 && digits.length <= 15 ? digits : null
  }
  const digits = t.replace(/\D/g, '')
  return digits.length >= 8 && digits.length <= 15 ? digits : null
}

/** Normalise "+91 98765-43210" / "919876543210" / full JID into a user JID. */
export function toJid(to: string): string {
  const t = to.trim()
  if (t.includes('@')) return t
  const digits = t.replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 15) throw new Error('invalid_recipient')
  return `${digits}@s.whatsapp.net`
}
