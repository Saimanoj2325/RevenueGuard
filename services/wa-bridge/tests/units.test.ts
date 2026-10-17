import { describe, expect, it } from 'vitest'
import { hmacHex, signedHeaders, verifySignature } from '../src/hmac.js'
import { redactPhones, deepRedact } from '../src/logger.js'
import { ConnectionStateMachine, backoffDelay } from '../src/state-machine.js'
import { SendRateLimiter } from '../src/rate-limit.js'
import { Store, parseSince } from '../src/store.js'
import { toJid } from '../src/wa/types.js'

describe('hmac', () => {
  const secret = 's3cret'
  it('round-trips and matches python hmac.new(key, body, sha256).hexdigest()', () => {
    const body = '{"a":1}'
    const h = signedHeaders(body, secret, 1_700_000_000)
    expect(h['X-RG-Signature']).toBe(`sha256=${hmacHex(body, secret)}`)
    expect(verifySignature(body, h['X-RG-Signature'], h['X-RG-Timestamp'], secret, 300, 1_700_000_100)).toEqual({ ok: true })
  })
  it('rejects tampering, stale timestamps and missing headers', () => {
    const h = signedHeaders('x', secret, 1000)
    expect(verifySignature('y', h['X-RG-Signature'], h['X-RG-Timestamp'], secret, 300, 1000)).toMatchObject({ ok: false, reason: 'bad_signature' })
    expect(verifySignature('x', h['X-RG-Signature'], h['X-RG-Timestamp'], secret, 300, 1301)).toMatchObject({ ok: false, reason: 'stale_timestamp' })
    expect(verifySignature('x', undefined, undefined, secret)).toMatchObject({ ok: false, reason: 'missing_headers' })
    expect(verifySignature('x', h['X-RG-Signature'], h['X-RG-Timestamp'], '')).toMatchObject({ ok: false, reason: 'missing_secret' })
  })
})

describe('log redaction', () => {
  it('masks phone numbers and jids', () => {
    expect(redactPhones('from 919876543210@s.whatsapp.net')).toBe('from ***3210@s.whatsapp.net')
    expect(redactPhones('call +91 98765-43210 now')).toBe('call ***3210 now')
    expect(redactPhones('PO-184 qty 60')).toBe('PO-184 qty 60')
    expect(deepRedact({ to: '919876543210@s.whatsapp.net', text: 'secret body' })).toEqual({ to: '***3210@s.whatsapp.net', text: '[redacted:11]' })
  })
})

describe('connection state machine', () => {
  it('allows the documented transitions only', () => {
    const sm = new ConnectionStateMachine()
    expect(sm.transition('open')).toBe(false)
    expect(sm.transition('connecting')).toBe(true)
    expect(sm.transition('qr')).toBe(true)
    expect(sm.transition('open')).toBe(true)
    expect(sm.transition('qr')).toBe(false)
    expect(sm.transition('connecting')).toBe(true)
    expect(sm.transition('disconnected')).toBe(true)
  })
  it('backoff grows exponentially and is capped', () => {
    expect(backoffDelay(0, 1000, 60000, () => 1)).toBe(1000)
    expect(backoffDelay(3, 1000, 60000, () => 1)).toBe(8000)
    expect(backoffDelay(30, 1000, 60000, () => 1)).toBe(60000)
    expect(backoffDelay(3, 1000, 60000, () => 0)).toBe(4000)
  })
})

describe('rate limiter', () => {
  it('enforces spacing and per-minute capacity', () => {
    let t = 0
    const rl = new SendRateLimiter(2, 1000, () => t)
    expect(rl.tryAcquire()).toBe(0)
    expect(rl.tryAcquire()).toBeGreaterThan(0) // spacing
    t = 1000
    expect(rl.tryAcquire()).toBe(0)
    t = 2000
    expect(rl.tryAcquire()).toBeGreaterThan(0) // bucket empty
  })
})

describe('store', () => {
  it('searches messages by term, chat and since', () => {
    const s = new Store(':memory:')
    const base = { from_name: 'Ops', direction: 'in' as const, media_mime: null, media_filename: null, media_path: null, media_size: null }
    s.upsertMessage({ ...base, id: 'a', chat_id: 'c1', from: 'u1', ts: 100, text: 'PO-184: 60 boxes dispatched' })
    s.upsertMessage({ ...base, id: 'b', chat_id: 'c1', from: 'u1', ts: 200, text: 'Correction: 70 delivered for PO-184' })
    s.upsertMessage({ ...base, id: 'c', chat_id: 'c2', from: 'u2', ts: 300, text: 'unrelated' })
    expect(s.upsertMessage({ ...base, id: 'a', chat_id: 'c1', from: 'u1', ts: 100, text: 'dup' })).toBe(false)
    expect(s.search({ q: 'PO-184' }).map((m) => m.id)).toEqual(['b', 'a'])
    expect(s.search({ q: 'po-184 correction' }).map((m) => m.id)).toEqual(['b'])
    expect(s.search({ chat: 'c2' }).map((m) => m.id)).toEqual(['c'])
    expect(s.search({ since: 150 }).map((m) => m.id)).toEqual(['c', 'b'])
    expect(s.search({ q: '100%' })).toEqual([])
  })
  it('idempotency keys can be claimed once', () => {
    const s = new Store(':memory:')
    const row = { key: 'k-000001', approval_id: 'ap1', to_jid: 'x@s.whatsapp.net', payload_hash: 'h' }
    expect(s.claimIdempotency(row)).toEqual({ claimed: true })
    s.completeIdempotency('k-000001', 'sent', 'MID')
    const again = s.claimIdempotency(row)
    expect(again.claimed).toBe(false)
    if (!again.claimed) expect(again.existing).toMatchObject({ status: 'sent', message_id: 'MID' })
  })
  it('parses since in seconds, ms, or ISO', () => {
    expect(parseSince('1700000000')).toBe(1700000000)
    expect(parseSince('1700000000000')).toBe(1700000000)
    expect(parseSince('2023-11-14T22:13:20Z')).toBe(1700000000)
    expect(parseSince('nope')).toBeUndefined()
  })
})

describe('toJid', () => {
  it('normalises numbers', () => {
    expect(toJid('+91 98765-43210')).toBe('919876543210@s.whatsapp.net')
    expect(toJid('123@g.us')).toBe('123@g.us')
    expect(() => toJid('12')).toThrow()
  })
})
