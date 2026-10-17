import type { Logger } from 'pino'
import { signedHeaders } from './hmac.js'

export type WaEvent =
  | { type: 'qr'; qr: string; ts: number }
  | { type: 'connection'; state: string; me?: { id: string; name?: string }; reason?: string; ts: number }
  | { type: 'message'; message: WaMessagePayload }
  | { type: 'message_edit'; edit: WaEditPayload }
  | { type: 'message_delete'; delete: WaDeletePayload }

/** CONTRACT_V3 §2: id is the ORIGINAL message id. */
export interface WaEditPayload {
  id: string
  chat_id: string
  from: string
  ts: number
  text: string
}

export interface WaDeletePayload {
  id: string
  chat_id: string
  from: string
  ts: number
}

export interface WaMessagePayload {
  id: string
  chat_id: string
  from: string
  from_name: string | null
  ts: number
  text?: string
  /** contextInfo.isForwarded (always present) */
  forwarded: boolean
  /** contextInfo.stanzaId of the quoted message, null when not a reply */
  quoted_id: string | null
  media?: { mime: string; filename: string; base64?: string; size?: number; truncated?: boolean; sha256?: string }
}

export type ApprovalChoice = 'approve' | 'reject' | 'proof'

/** Posts signed events to API /internal/wa-events with bounded retries. */
export class ApiClient {
  constructor(
    private readonly apiUrl: string,
    private readonly secret: string,
    private readonly log: Logger,
    private readonly attempts = 3,
    private readonly timeoutMs = 15_000,
  ) {}

  /**
   * Forward an approver's WhatsApp reply to POST /internal/wa-approval-reply (HMAC-signed, single attempt:
   * approving is not something to retry blindly). Returns the API's reply text for the approver, if any.
   */
  async postApprovalReply(body: { phone: string; approval_id: string; choice: ApprovalChoice; token: string }): Promise<{ ok: boolean; status: number; reply: string | null }> {
    const raw = JSON.stringify(body)
    try {
      const res = await fetch(`${this.apiUrl}/internal/wa-approval-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signedHeaders(raw, this.secret) },
        body: raw,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      let reply: string | null = null
      try {
        const j = (await res.json()) as Record<string, unknown>
        const r = j.reply ?? j.text ?? j.message
        if (typeof r === 'string' && r.trim()) reply = r
      } catch {
        /* non-JSON body */
      }
      if (!res.ok) this.log.warn({ status: res.status, approval_id: body.approval_id }, 'api rejected wa-approval-reply')
      return { ok: res.ok, status: res.status, reply }
    } catch (err) {
      this.log.warn({ err: (err as Error).message, approval_id: body.approval_id }, 'api wa-approval-reply error')
      return { ok: false, status: 0, reply: null }
    }
  }

  async postEvent(ev: WaEvent): Promise<boolean> {
    const body = JSON.stringify(ev)
    for (let i = 0; i < this.attempts; i++) {
      try {
        const res = await fetch(`${this.apiUrl}/internal/wa-events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...signedHeaders(body, this.secret) },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (res.ok) return true
        // 4xx (other than 408/429) won't get better by retrying
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          this.log.warn({ status: res.status, type: ev.type }, 'api rejected wa-event')
          return false
        }
        this.log.warn({ status: res.status, type: ev.type, attempt: i + 1 }, 'api wa-event failed')
      } catch (err) {
        this.log.warn({ err: (err as Error).message, type: ev.type, attempt: i + 1 }, 'api wa-event error')
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** i))
    }
    return false
  }
}
