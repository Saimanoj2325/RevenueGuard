import { pino, type Logger } from 'pino'
import { config } from './config.js'

/**
 * Phone numbers and WhatsApp JIDs are personal data: logs keep only the last 4 digits.
 * Applied to every string in every log object (deep) and to the log message itself.
 */
const JID_RE = /(\d{5,})(?=(?::\d+)?@(?:s\.whatsapp\.net|c\.us|lid|g\.us|broadcast))/g
const PHONE_RE = /(?<![\w.])\+?\d[\d\s().-]{7,}\d(?![\w.])/g

export function redactPhones(s: string): string {
  return s
    .replace(JID_RE, (m) => `***${m.slice(-4)}`)
    .replace(PHONE_RE, (m) => {
      const digits = m.replace(/\D/g, '')
      if (digits.length < 8 || digits.length > 15) return m
      return `***${digits.slice(-4)}`
    })
}

const SENSITIVE_KEYS = new Set(['base64', 'text', 'body', 'qr', 'creds', 'keys', 'noiseKey', 'signedIdentityKey'])

export function deepRedact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]'
  if (typeof value === 'string') return redactPhones(value)
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => deepRedact(v, depth + 1))
  if (value instanceof Error) return { type: value.name, message: redactPhones(value.message), stack: value.stack ? redactPhones(value.stack) : undefined }
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[bytes:${(value as Uint8Array).length}]`
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) && typeof v === 'string' ? `[redacted:${v.length}]` : deepRedact(v, depth + 1)
    }
    return out
  }
  return value
}

export function createLogger(level = config.logLevel): Logger {
  return pino({
    level,
    base: { svc: 'wa-bridge' },
    formatters: { log: (obj) => deepRedact(obj) as Record<string, unknown> },
    hooks: {
      logMethod(args, method) {
        const redacted = args.map((a) => (typeof a === 'string' ? redactPhones(a) : a)) as Parameters<typeof method>
        return method.apply(this, redacted)
      },
    },
  })
}

export const logger = createLogger()
