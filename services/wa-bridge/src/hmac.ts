/**
 * Service-to-service HMAC per docs/CONTRACT.md:
 *   X-RG-Signature: sha256=<hex hmac-sha256 of the raw body>
 *   X-RG-Timestamp: unix seconds; reject if skew > 300s.
 * The signature covers the raw body only (matches services/api/app/security.py).
 */
import crypto from 'node:crypto'

export const SIG_HEADER = 'x-rg-signature'
export const TS_HEADER = 'x-rg-timestamp'

export function hmacHex(body: string | Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

export function signedHeaders(body: string | Buffer, secret: string, nowSec = Math.floor(Date.now() / 1000)): Record<string, string> {
  return {
    'X-RG-Signature': `sha256=${hmacHex(body, secret)}`,
    'X-RG-Timestamp': String(nowSec),
  }
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'missing_secret' | 'missing_headers' | 'bad_timestamp' | 'stale_timestamp' | 'bad_signature' }

export function verifySignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  secret: string,
  maxSkewSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!secret) return { ok: false, reason: 'missing_secret' }
  if (!signatureHeader || !timestampHeader) return { ok: false, reason: 'missing_headers' }
  let ts = Number(timestampHeader)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' }
  if (ts > 1e12) ts = Math.floor(ts / 1000) // tolerate milliseconds
  if (Math.abs(nowSec - ts) > maxSkewSec) return { ok: false, reason: 'stale_timestamp' }
  const provided = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader
  const expected = hmacHex(rawBody, secret)
  const a = Buffer.from(provided, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' }
  return { ok: true }
}
