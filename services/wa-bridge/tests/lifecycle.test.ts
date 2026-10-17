import { afterAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { Writable } from 'node:stream'
import { pino } from 'pino'
import { createLogger } from '../src/logger.js'
import { Bridge } from '../src/bridge.js'
import { config } from '../src/config.js'
import { Store } from '../src/store.js'
import { MockConnector } from '../src/wa/mock.js'
import { BaileysConnector, textOf } from '../src/wa/baileys.js'
import { buildServer } from '../src/server.js'
import { signedHeaders } from '../src/hmac.js'
import type { ApiClient, WaEvent } from '../src/api-client.js'
import type { ConnectorHooks, InboundEnvelope } from '../src/wa/types.js'

const secret = 'test-secret'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-life-'))
const OPS = '120363000000000001@g.us'
const FAMILY = '120363000000000099@g.us'
const DRIVER = '919822223333@s.whatsapp.net'
const SECRET = 'PRIVATE family edit 9931'

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function makeEnv(opts: { failApi?: () => boolean } = {}) {
  const events: WaEvent[] = []
  const fakeApi = {
    postEvent: async (e: WaEvent) => {
      if (opts.failApi?.()) return false
      events.push(e)
      return true
    },
    postApprovalReply: async () => ({ ok: true, status: 200, reply: null }),
  } as unknown as ApiClient
  const logLines: string[] = []
  const log = pino({ level: 'debug' }, new Writable({ write(c, _e, cb) { logLines.push(String(c)); cb() } }))
  const dir = fs.mkdtempSync(path.join(root, 'env-'))
  const cfg = { ...config, mock: true, demoMode: false, hmacSecret: secret, mediaDir: path.join(dir, 'media'), sendMinIntervalMs: 0, sendRatePerMinute: 100, forwardRetryIntervalMs: 20 }
  const store = new Store(':memory:')
  const bridge = new Bridge(cfg, store, fakeApi, log)
  bridge.setAllowlist([OPS])
  const mock = new MockConnector(bridge.hooks(), createLogger('silent'), 0)
  bridge.connector = mock
  const app = buildServer(bridge)
  return { events, logLines, store, bridge, mock, app }
}
const tick = () => new Promise((r) => setTimeout(r, 20))
const signed = (body: unknown) => {
  const raw = JSON.stringify(body)
  return { payload: raw, headers: { 'content-type': 'application/json', ...signedHeaders(raw, secret) } }
}
const ofType = <T extends WaEvent['type']>(evs: WaEvent[], t: T) => evs.filter((e): e is Extract<WaEvent, { type: T }> => e.type === t)

/** Baileys connector with stub hooks; sock is never needed for the paths under test. */
function baileys(allow: (env: InboundEnvelope) => boolean) {
  const calls = { admit: [] as InboundEnvelope[], edits: [] as unknown[], deletes: [] as unknown[], messages: [] as unknown[] }
  const hooks: ConnectorHooks = {
    onState() {},
    onQr() {},
    onMessage: (m) => calls.messages.push(m),
    onEdit: (e) => calls.edits.push(e),
    onDelete: (d) => calls.deletes.push(d),
    admit: (env) => { calls.admit.push(env); return allow(env) },
  }
  const conn = new BaileysConnector(
    { authDir: path.join(root, 'auth'), reconnectBaseMs: 1, reconnectMaxMs: 1, maxMediaBytes: 10, browserName: 't', baileysLogLevel: 'silent' },
    hooks,
    createLogger('silent'),
  )
  const c = conn as unknown as {
    parseMessage: (s: unknown, m: unknown, live: boolean) => Promise<unknown>
    handleUpdate: (u: unknown) => void
  }
  return { calls, parse: (m: unknown, live = true) => c.parseMessage(undefined, m, live), update: (u: unknown) => c.handleUpdate(u) }
}
const groupKey = (id: string, chat = OPS) => ({ id, remoteJid: chat, participant: DRIVER, fromMe: false })

describe('Baileys: edits and deletes (CONTRACT_V3 §2)', () => {
  it('messages.upsert protocolMessage MESSAGE_EDIT -> onEdit with new text (conversation / extended / caption)', async () => {
    const b = baileys(() => true)
    const edit = (editedMessage: unknown, id: string) => ({
      key: groupKey(`P${id}`), pushName: 'Ravi', messageTimestamp: 1_760_000_100,
      message: { editedMessage: { message: { protocolMessage: { type: 14, key: { id }, editedMessage, timestampMs: 1_760_000_200_000 } } } },
    })
    expect(await b.parse(edit({ conversation: '70 boxes, not 60' }, 'ORIG1'))).toBeUndefined()
    await b.parse(edit({ extendedTextMessage: { text: 'PO-184 delivered' } }, 'ORIG2'))
    await b.parse(edit({ imageMessage: { caption: 'challan 5512' } }, 'ORIG3'))
    expect(b.calls.edits).toEqual([
      { id: 'ORIG1', chat_id: OPS, from: DRIVER, from_name: 'Ravi', ts: 1_760_000_200, text: '70 boxes, not 60', live: true },
      { id: 'ORIG2', chat_id: OPS, from: DRIVER, from_name: 'Ravi', ts: 1_760_000_200, text: 'PO-184 delivered', live: true },
      { id: 'ORIG3', chat_id: OPS, from: DRIVER, from_name: 'Ravi', ts: 1_760_000_200, text: 'challan 5512', live: true },
    ])
    expect(b.calls.messages).toHaveLength(0)
  })

  it('messages.upsert protocolMessage REVOKE -> onDelete with the deleted key.id; other protocol types ignored', async () => {
    const b = baileys(() => true)
    await b.parse({ key: groupKey('P9'), messageTimestamp: 1_760_000_300, message: { protocolMessage: { type: 0, key: { id: 'GONE1' } } } })
    await b.parse({ key: groupKey('P10'), messageTimestamp: 1_760_000_300, message: { protocolMessage: { type: 3, ephemeralExpiration: 0 } } })
    expect(b.calls.deletes).toEqual([{ id: 'GONE1', chat_id: OPS, from: DRIVER, ts: 1_760_000_300, live: true }])
    expect(b.calls.admit).toHaveLength(1) // ephemeral setting never even reached the gate
  })

  it('messages.update: editedMessage -> onEdit, messageStubType REVOKE -> onDelete, receipts untouched', () => {
    const b = baileys(() => true)
    b.update({ key: groupKey('ORIG4'), update: { message: { editedMessage: { message: { conversation: 'corrected: 65' } } }, messageTimestamp: 1_760_000_400 } })
    b.update({ key: groupKey('ORIG5'), update: { message: null, messageStubType: 1, key: groupKey('P11') } })
    b.update({ key: groupKey('ORIG6'), update: { status: 4 } })
    b.update({ key: { ...groupKey('ORIG7'), fromMe: true }, update: { message: { editedMessage: { message: { conversation: 'mine' } } } } })
    expect(b.calls.edits).toEqual([{ id: 'ORIG4', chat_id: OPS, from: DRIVER, from_name: null, ts: 1_760_000_400, text: 'corrected: 65', live: true }])
    expect(b.calls.deletes).toMatchObject([{ id: 'ORIG5', chat_id: OPS, from: DRIVER }])
    expect(b.calls.admit).toHaveLength(2)
  })

  it('edits/deletes from a non-allowlisted chat are dropped at the gate, before the new text is read', async () => {
    const b = baileys(() => false)
    // a getter on the edited content proves nobody reads it after the gate says no
    let read = false
    const edited = { get conversation() { read = true; return SECRET } }
    await b.parse({ key: groupKey('P12', FAMILY), messageTimestamp: 1_760_000_500, message: { protocolMessage: { type: 14, key: { id: 'F1' }, editedMessage: edited } } })
    b.update({ key: groupKey('F2', FAMILY), update: { message: { editedMessage: { message: edited } } } })
    b.update({ key: groupKey('F3', FAMILY), update: { message: null, messageStubType: 1 } })
    expect(read).toBe(false)
    expect(b.calls.edits).toHaveLength(0)
    expect(b.calls.deletes).toHaveLength(0)
    expect(b.calls.admit.map((a) => a.chat_id)).toEqual([FAMILY, FAMILY, FAMILY])
  })

  it('every message carries forwarded + quoted_id; media carries sha256 (base64 of fileSha256)', async () => {
    const b = baileys(() => true)
    const sha = crypto.createHash('sha256').update('JPEGBYTES').digest()
    const fwd = (await b.parse({
      key: groupKey('M1'), pushName: 'Ravi', messageTimestamp: 1_760_000_600,
      message: { extendedTextMessage: { text: 'see above', contextInfo: { isForwarded: true, forwardingScore: 1, stanzaId: 'Q1' } } },
    })) as Record<string, unknown>
    expect(fwd).toMatchObject({ id: 'M1', text: 'see above', is_forwarded: true, quoted_id: 'Q1' })
    const plain = (await b.parse({ key: groupKey('M2'), messageTimestamp: 1_760_000_601, message: { conversation: 'hi' } })) as Record<string, unknown>
    expect(plain.is_forwarded).toBe(false)
    expect(plain.quoted_id).toBeUndefined()
    // declared size over maxMediaBytes (10): no download (sock undefined), sha256 still taken from the message
    const img = (await b.parse({
      key: groupKey('M3'), messageTimestamp: 1_760_000_602,
      message: { imageMessage: { caption: 'challan', mimetype: 'image/jpeg', fileLength: 5000, fileSha256: new Uint8Array(sha), contextInfo: { stanzaId: 'Q2' } } },
    })) as { media: { sha256: string }; quoted_id: string }
    expect(img.media.sha256).toBe(sha.toString('base64'))
    expect(img.quoted_id).toBe('Q2')
  })

  it('textOf unwraps edited / ephemeral wrappers', () => {
    expect(textOf({ ephemeralMessage: { message: { extendedTextMessage: { text: 'x' } } } })).toBe('x')
    expect(textOf({ documentMessage: { caption: 'inv.pdf' } })).toBe('inv.pdf')
    expect(textOf(undefined)).toBeUndefined()
  })
})

describe('Bridge: lifecycle events to the API', () => {
  it('edit -> message_edit (original id, new text), local copy updated; the duplicate upsert+update pair is sent once', async () => {
    const env = makeEnv()
    await env.bridge.handleInbound({ id: 'A1', chat_id: OPS, from: DRIVER, from_name: 'Ravi', ts: 100, text: '60 boxes', live: true })
    await env.bridge.handleEdit({ id: 'A1', chat_id: OPS, from: DRIVER, from_name: 'Ravi', ts: 160, text: '70 boxes', live: true })
    await env.bridge.handleEdit({ id: 'A1', chat_id: OPS, from: DRIVER, from_name: null, ts: 160, text: '70 boxes', live: true })
    expect(ofType(env.events, 'message_edit')).toEqual([{ type: 'message_edit', edit: { id: 'A1', chat_id: OPS, from: DRIVER, ts: 160, text: '70 boxes' } }])
    expect(env.store.get('A1')).toMatchObject({ text: '70 boxes', edited_at: 160 })
    // a second, different edit is a new event
    await env.bridge.handleEdit({ id: 'A1', chat_id: OPS, from: DRIVER, ts: 170, text: '72 boxes', live: true })
    expect(ofType(env.events, 'message_edit').map((e) => e.edit.text)).toEqual(['70 boxes', '72 boxes'])
  })

  it('delete -> message_delete once; row kept locally but hidden from search', async () => {
    const env = makeEnv()
    await env.bridge.handleInbound({ id: 'D1', chat_id: OPS, from: DRIVER, from_name: 'Ravi', ts: 100, text: 'PO-999 cancelled', live: true })
    await env.bridge.handleDelete({ id: 'D1', chat_id: OPS, from: DRIVER, ts: 130, live: true })
    await env.bridge.handleDelete({ id: 'D1', chat_id: OPS, from: DRIVER, ts: 131, live: true })
    expect(ofType(env.events, 'message_delete')).toEqual([{ type: 'message_delete', delete: { id: 'D1', chat_id: OPS, from: DRIVER, ts: 130 } }])
    expect(env.store.get('D1')?.deleted).toBe(true)
    expect(env.store.search({ q: 'PO-999' })).toHaveLength(0)
  })

  it('edit/delete from a non-allowlisted chat: nothing stored, logged or forwarded', async () => {
    const env = makeEnv()
    await env.bridge.handleEdit({ id: 'X1', chat_id: FAMILY, from: DRIVER, ts: 1, text: SECRET, live: true })
    await env.bridge.handleDelete({ id: 'X2', chat_id: FAMILY, from: DRIVER, ts: 1, live: true })
    expect(env.store.lifecycleCount()).toBe(0)
    expect(env.events.filter((e) => e.type !== 'connection' && e.type !== 'qr')).toHaveLength(0)
    expect(env.logLines.join('\n')).not.toContain('9931')
    expect(env.bridge.droppedTotal).toBe(2)
  })

  it('edit before the original (out of order) is forwarded and applied to the local copy when the original lands', async () => {
    const env = makeEnv()
    await env.bridge.handleEdit({ id: 'O1', chat_id: OPS, from: DRIVER, ts: 200, text: 'fixed text', live: true })
    expect(ofType(env.events, 'message_edit')).toHaveLength(1)
    await env.bridge.handleInbound({ id: 'O1', chat_id: OPS, from: DRIVER, from_name: 'Ravi', ts: 190, text: 'typo text', live: true })
    expect(env.store.get('O1')).toMatchObject({ text: 'fixed text', edited_at: 200 })
  })

  it('lifecycle events the API did not acknowledge are retried by the retry loop', async () => {
    let fail = true
    const env = makeEnv({ failApi: () => fail })
    await env.bridge.handleEdit({ id: 'R1', chat_id: OPS, from: DRIVER, ts: 1, text: 'new', live: true })
    expect(env.store.unforwardedLifecycle()).toHaveLength(1)
    fail = false
    env.bridge.startRetryLoop()
    await new Promise((r) => setTimeout(r, 80))
    env.bridge.stop()
    expect(ofType(env.events, 'message_edit')).toHaveLength(1)
    expect(env.store.unforwardedLifecycle()).toHaveLength(0)
  })

  it('message payload carries forwarded, quoted_id and media.sha256 (computed from bytes when Baileys gave none)', async () => {
    const env = makeEnv()
    const data = Buffer.from('PNGDATA')
    await env.bridge.handleInbound({ id: 'F1', chat_id: OPS, from: DRIVER, from_name: 'Ravi', ts: 1, text: 'fwd', is_forwarded: true, quoted_id: 'Q9', live: true })
    await env.bridge.handleInbound({ id: 'F2', chat_id: OPS, from: DRIVER, from_name: 'Ravi', ts: 2, media: { mime: 'image/png', filename: 'c.png', data }, live: true })
    await env.bridge.handleInbound({ id: 'F3', chat_id: OPS, from: DRIVER, from_name: 'Ravi', ts: 3, media: { mime: 'image/png', filename: 'big.png', data: Buffer.alloc(0), sha256: 'BAILEYSHASH==' }, live: true })
    const msgs = ofType(env.events, 'message').map((e) => e.message)
    expect(msgs[0]).toMatchObject({ id: 'F1', forwarded: true, quoted_id: 'Q9' })
    expect(msgs[1]).toMatchObject({ id: 'F2', forwarded: false, quoted_id: null })
    expect(msgs[1]!.media!.sha256).toBe(crypto.createHash('sha256').update(data).digest('base64'))
    expect(msgs[2]!.media).toMatchObject({ truncated: true, sha256: 'BAILEYSHASH==' })
  })
})

describe('WA_MOCK: edit / delete / resend simulation', () => {
  it('/mock/edit, /mock/delete and /mock/resend drive the same events as a real session', async () => {
    const env = makeEnv()
    await env.mock.start()
    env.mock.scan()
    const b64 = Buffer.from('CHALLAN-JPEG').toString('base64')
    const inj = await env.app.inject({ method: 'POST', url: '/mock/inject', ...signed({ id: 'MK1', chat_id: OPS, from: DRIVER, text: 'challan 5512', media: { mime: 'image/jpeg', filename: 'c.jpg', base64: b64 }, quoted_id: 'MK0' }) })
    expect(inj.json()).toEqual({ ok: true, id: 'MK1' })
    const unsigned = await env.app.inject({ method: 'POST', url: '/mock/edit', payload: { id: 'MK1', text: 'x' } })
    expect(unsigned.statusCode).toBe(401)
    expect((await env.app.inject({ method: 'POST', url: '/mock/edit', ...signed({ id: 'MK1', text: 'challan 5513' }) })).json()).toEqual({ ok: true, id: 'MK1' })
    expect((await env.app.inject({ method: 'POST', url: '/mock/resend', ...signed({ id: 'MK1', new_id: 'MK2' }) })).json()).toEqual({ ok: true, id: 'MK2' })
    expect((await env.app.inject({ method: 'POST', url: '/mock/delete', ...signed({ id: 'MK1' }) })).json()).toEqual({ ok: true, id: 'MK1' })
    expect((await env.app.inject({ method: 'POST', url: '/mock/delete', ...signed({ id: 'NOPE' }) })).statusCode).toBe(404)
    await tick()
    const msgs = ofType(env.events, 'message').map((e) => e.message)
    expect(msgs.map((m) => m.id)).toEqual(['MK1', 'MK2'])
    expect(msgs[0]).toMatchObject({ forwarded: false, quoted_id: 'MK0' })
    expect(msgs[1]).toMatchObject({ forwarded: true, quoted_id: 'MK0', text: 'challan 5513' })
    expect(msgs[1]!.media!.sha256).toBe(msgs[0]!.media!.sha256) // same bytes -> same hash (duplicate detection input)
    expect(ofType(env.events, 'message_edit').map((e) => e.edit)).toEqual([expect.objectContaining({ id: 'MK1', chat_id: OPS, from: DRIVER, text: 'challan 5513' })])
    expect(ofType(env.events, 'message_delete').map((e) => e.delete)).toEqual([expect.objectContaining({ id: 'MK1', chat_id: OPS, from: DRIVER })])
  })

  it('mock edit into a non-allowlisted chat is dropped', async () => {
    const env = makeEnv()
    await env.mock.start()
    env.mock.scan()
    await env.app.inject({ method: 'POST', url: '/mock/inject', ...signed({ id: 'FM1', chat_id: FAMILY, from: DRIVER, text: 'hello' }) })
    const r = await env.app.inject({ method: 'POST', url: '/mock/edit', ...signed({ id: 'FM1', text: SECRET }) })
    expect(r.json().ok).toBe(true) // the mock "sent" it; the bridge gate dropped it
    await tick()
    expect(env.store.lifecycleCount()).toBe(0)
    expect(env.events.filter((e) => e.type === 'message' || e.type === 'message_edit')).toHaveLength(0)
  })
})

describe('store migration', () => {
  it('adds the v3 columns to a pre-v3 messages table without losing rows', async () => {
    const { default: Database } = await import('better-sqlite3')
    const p = path.join(fs.mkdtempSync(path.join(root, 'mig-')), 'db.sqlite')
    const db = new Database(p)
    db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, from_jid TEXT NOT NULL, from_name TEXT, ts INTEGER NOT NULL, text TEXT,
      direction TEXT NOT NULL DEFAULT 'in', media_mime TEXT, media_filename TEXT, media_path TEXT, media_size INTEGER,
      forwarded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      INSERT INTO messages (id, chat_id, from_jid, ts, text) VALUES ('old', '${OPS}', '${DRIVER}', 1, 'hello')`)
    db.close()
    const s = new Store(p)
    expect(s.get('old')).toMatchObject({ text: 'hello', is_forwarded: false, quoted_id: null, media_sha256: null, deleted: false, edited_at: null })
    expect(s.search({ q: 'hello' })).toHaveLength(1)
    s.close()
  })
})
