import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createLogger } from '../src/logger.js'
import { Bridge } from '../src/bridge.js'
import { config } from '../src/config.js'
import { Store } from '../src/store.js'
import { MockConnector } from '../src/wa/mock.js'
import { buildServer } from '../src/server.js'
import { signedHeaders } from '../src/hmac.js'
import type { ApiClient, WaEvent } from '../src/api-client.js'

const secret = 'test-secret'
const events: WaEvent[] = []
const fakeApi = { postEvent: async (e: WaEvent) => { events.push(e); return true } } as unknown as ApiClient
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-'))
const cfg = { ...config, mock: true, hmacSecret: secret, mediaDir: path.join(dir, 'media'), sendMinIntervalMs: 0, sendRatePerMinute: 100 }
const bridge = new Bridge(cfg, new Store(':memory:'), fakeApi, createLogger('silent'))
const mock = new MockConnector(bridge.hooks(), createLogger('silent'), 0)
bridge.connector = mock
const app = buildServer(bridge)

const signed = (body: unknown) => {
  const raw = JSON.stringify(body)
  return { payload: raw, headers: { 'content-type': 'application/json', ...signedHeaders(raw, secret) } }
}

beforeAll(async () => { await mock.start() })
afterAll(async () => { await app.close() })

describe('wa-bridge server (mock mode)', () => {
  it('exposes QR as PNG data URL, then opens after scan', async () => {
    const qr = (await app.inject({ method: 'GET', url: '/qr' })).json()
    expect(qr.qr).toMatch(/^data:image\/png;base64,/)
    expect(events.some((e) => e.type === 'qr')).toBe(true)
    await app.inject({ method: 'POST', url: '/mock/scan', ...signed({}) })
    const st = (await app.inject({ method: 'GET', url: '/status' })).json()
    expect(st.state).toBe('open')
    expect(st.me.id).toContain('@s.whatsapp.net')
  })

  it('rejects unsigned /send and refuses repeated idempotency keys', async () => {
    const body = { to: '+91 98000 00002', text: 'Invoice INV-1 for PO-184', idempotency_key: 'idem-12345678', approval_id: 'ap-1' }
    const unsigned = await app.inject({ method: 'POST', url: '/send', payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    expect(unsigned.statusCode).toBe(401)
    const first = await app.inject({ method: 'POST', url: '/send', ...signed(body) })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ ok: true })
    const second = await app.inject({ method: 'POST', url: '/send', ...signed(body) })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ ok: false, error: 'duplicate_idempotency_key', message_id: first.json().message_id })
    expect(mock.sent).toHaveLength(1)
  })

  it('idempotency read-check reports sent / unknown keys (gateway uses it before any resend)', async () => {
    const hit = await app.inject({ method: 'POST', url: '/idempotency/lookup', ...signed({ idempotency_key: 'idem-12345678' }) })
    expect(hit.statusCode).toBe(200)
    expect(hit.json()).toMatchObject({ found: true, status: 'sent' })
    expect(hit.json().message_id).toBeTruthy()
    const miss = await app.inject({ method: 'POST', url: '/idempotency/lookup', ...signed({ idempotency_key: 'idem-never-used' }) })
    expect(miss.statusCode).toBe(404)
    const unsigned = await app.inject({ method: 'POST', url: '/idempotency/lookup', payload: JSON.stringify({ idempotency_key: 'idem-12345678' }), headers: { 'content-type': 'application/json' } })
    expect(unsigned.statusCode).toBe(401)
  })

  it('injects demo messages (text + media), forwards to API and makes them searchable', async () => {
    const r = await app.inject({ method: 'POST', url: '/mock/inject', ...signed({ text: 'Correction: 70 delivered (PO-184)' }) })
    expect(r.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/mock/inject', ...signed({ text: 'voice note', media: { mime: 'audio/ogg; codecs=opus', filename: 'vn.ogg', base64: Buffer.from('OggS').toString('base64') } }) })
    await new Promise((res) => setTimeout(res, 20))
    const msgs = events.filter((e): e is Extract<WaEvent, { type: 'message' }> => e.type === 'message')
    expect(msgs.length).toBe(2)
    expect(msgs[1]!.message.media).toMatchObject({ mime: 'audio/ogg; codecs=opus', base64: Buffer.from('OggS').toString('base64') })
    const s = (await app.inject({ method: 'GET', url: '/messages/search?q=correction' })).json()
    expect(s.messages[0].text).toContain('70 delivered')
  })
})
