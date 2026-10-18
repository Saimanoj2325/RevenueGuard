import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { Writable } from 'node:stream'
import { pino } from 'pino'
import { createLogger } from '../src/logger.js'
import { APPROVAL_EXPIRED_TEXT, Bridge, parseApprovalChoice } from '../src/bridge.js'
import { config } from '../src/config.js'
import { Store } from '../src/store.js'
import { MockConnector } from '../src/wa/mock.js'
import { BaileysConnector } from '../src/wa/baileys.js'
import { buildServer } from '../src/server.js'
import { signedHeaders } from '../src/hmac.js'
import type { ApiClient, WaEvent } from '../src/api-client.js'
import type { InboundMessage } from '../src/wa/types.js'

const secret = 'test-secret'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-allow-'))
const SECRET_BODY = 'PRIVATE family message 4711'
const FAMILY = '120363000000000099@g.us'
const OPS = '120363000000000001@g.us'
const APPROVER = '919811112222@s.whatsapp.net'

type ReplyCall = { phone: string; approval_id: string; choice: string; token: string }

function makeEnv(opts: { mock?: boolean; demoMode?: boolean; dbPath?: string; rate?: number } = {}) {
  const events: WaEvent[] = []
  const replies: ReplyCall[] = []
  let apiAnswer: { ok: boolean; status: number; reply: string | null } = { ok: true, status: 200, reply: 'Done. Approved.' }
  const fakeApi = {
    postEvent: async (e: WaEvent) => {
      events.push(e)
      return true
    },
    postApprovalReply: async (b: ReplyCall) => {
      replies.push(b)
      return apiAnswer
    },
  } as unknown as ApiClient
  const logLines: string[] = []
  const sink = new Writable({ write(chunk, _enc, cb) { logLines.push(String(chunk)); cb() } })
  const log = pino({ level: 'debug' }, sink)
  const dir = fs.mkdtempSync(path.join(root, 'env-'))
  const cfg = {
    ...config,
    mock: opts.mock ?? false,
    demoMode: opts.demoMode ?? false,
    hmacSecret: secret,
    mediaDir: path.join(dir, 'media'),
    sendMinIntervalMs: 0,
    sendRatePerMinute: opts.rate ?? 100,
    approvalReplyTimeoutMs: 100,
  }
  const store = new Store(opts.dbPath ?? ':memory:')
  const bridge = new Bridge(cfg, store, fakeApi, log)
  const mock = new MockConnector(bridge.hooks(), createLogger('silent'), 0)
  bridge.connector = mock
  const app = buildServer(bridge)
  return { events, replies, logLines, cfg, store, bridge, mock, app, setApiAnswer: (a: typeof apiAnswer) => (apiAnswer = a) }
}

async function open(env: ReturnType<typeof makeEnv>) {
  await env.mock.start()
  env.mock.scan()
}

const signed = (body: unknown) => {
  const raw = JSON.stringify(body)
  return { payload: raw, headers: { 'content-type': 'application/json', ...signedHeaders(raw, secret) } }
}
const signedGet = () => ({ headers: signedHeaders('', secret) })

let n = 0
const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  id: `M${++n}`,
  chat_id: FAMILY,
  from: '919822223333@s.whatsapp.net',
  from_name: 'Aunty',
  ts: 1_760_000_000 + n,
  text: SECRET_BODY,
  live: true,
  ...over,
})

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('chat allowlist (privacy gate)', () => {
  it('default empty allowlist drops everything: nothing stored, written, logged or forwarded', async () => {
    const env = makeEnv()
    expect(env.bridge.getAllowlist()).toEqual([])
    await env.bridge.handleInbound(msg({ media: { mime: 'image/jpeg', filename: 'x.jpg', data: Buffer.from('JPEGDATA') } }))
    await env.bridge.handleInbound(msg({ chat_id: '919822223333@s.whatsapp.net', from_name: 'Cousin' }))
    expect(env.store.count()).toBe(0)
    expect(env.store.search({}).length).toBe(0)
    expect(env.events.filter((e) => e.type === 'message')).toHaveLength(0)
    expect(fs.existsSync(env.cfg.mediaDir)).toBe(false)
    expect(env.bridge.droppedTotal).toBe(2)
    const logs = env.logLines.join('\n')
    expect(logs).not.toContain(SECRET_BODY)
    expect(logs).not.toContain('4711')
    expect(logs).toMatch(/"dropped":1/) // only a count
  })

  it('non-allowlisted chats still appear in GET /chats with name + time, never a body', async () => {
    const env = makeEnv()
    await env.bridge.handleInbound(msg({ chat_id: '919822223333@s.whatsapp.net', from_name: 'Cousin', ts: 1_760_000_500 }))
    env.bridge.hooks().onChats!([{ jid: FAMILY, name: 'Family', is_group: true, last_message_at: 1_760_000_100 }])
    const unsigned = await env.app.inject({ method: 'GET', url: '/chats' })
    expect(unsigned.statusCode).toBe(401)
    const r = await env.app.inject({ method: 'GET', url: '/chats', ...signedGet() })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual([
      { jid: '919822223333@s.whatsapp.net', name: 'Cousin', is_group: false, kind: 'person', phone: '919822223333', last_message_at: 1_760_000_500 },
      { jid: FAMILY, name: 'Family', is_group: true, kind: 'group', last_message_at: 1_760_000_100 },
    ])
    expect(r.body).not.toContain(SECRET_BODY)
  })

  it('only allowlisted chats are stored/forwarded; a group is matched by group JID, not by participant', async () => {
    const env = makeEnv()
    env.bridge.setAllowlist([OPS, '919822223333@s.whatsapp.net'])
    await env.bridge.handleInbound(msg({ chat_id: OPS, text: 'PO-184 60 boxes dispatched' }))
    // allowlisted person writing in a NON-allowlisted group -> dropped
    await env.bridge.handleInbound(msg({ chat_id: FAMILY, from: '919822223333@s.whatsapp.net' }))
    // 1:1 chat addressed by LID, phone JID alias allowlisted -> kept
    await env.bridge.handleInbound(msg({ chat_id: '12345678901234@lid', from: '919822223333@s.whatsapp.net', text: 'delivered 70' }))
    expect(env.store.count()).toBe(2)
    expect(env.store.search({ q: 'private' })).toHaveLength(0)
    const fwd = env.events.filter((e): e is Extract<WaEvent, { type: 'message' }> => e.type === 'message')
    expect(fwd.map((e) => e.message.text)).toEqual(['PO-184 60 boxes dispatched', 'delivered 70'])
  })

  it('mock /mock/inject from a non-allowlisted chat is dropped too', async () => {
    const env = makeEnv({ mock: true })
    await open(env)
    await env.app.inject({ method: 'POST', url: '/mock/inject', ...signed({ chat_id: FAMILY, from: '919822223333@s.whatsapp.net', text: SECRET_BODY }) })
    await new Promise((r) => setTimeout(r, 20))
    expect(env.store.count()).toBe(0)
    expect(env.events.filter((e) => e.type === 'message')).toHaveLength(0)
  })

  it('Baileys connector gates before parsing/downloading media', async () => {
    const seen: unknown[] = []
    const conn = new BaileysConnector(
      { authDir: path.join(root, 'auth'), reconnectBaseMs: 1, reconnectMaxMs: 1, maxMediaBytes: 1e6, browserName: 't', baileysLogLevel: 'silent' },
      { onState() {}, onQr() {}, onMessage: (m) => seen.push(m), admit: (env) => { seen.push(env); return false } },
      createLogger('silent'),
    )
    const wa = {
      key: { id: 'ABC', remoteJid: FAMILY, participant: '919822223333@s.whatsapp.net', fromMe: false },
      pushName: 'Aunty',
      messageTimestamp: 1_760_000_000,
      message: { imageMessage: { caption: SECRET_BODY, mimetype: 'image/jpeg', url: 'https://mmg.whatsapp.net/x' } },
    }
    // sock is undefined: if the gate did not run first, downloadMediaMessage would throw
    const out = await (conn as unknown as { parseMessage: (s: unknown, m: unknown, live: boolean) => Promise<unknown> }).parseMessage(undefined, wa, true)
    expect(out).toBeUndefined()
    expect(seen).toEqual([{ chat_id: FAMILY, is_group: true, push_name: 'Aunty', ts: 1_760_000_000 }])
  })

  it('search hides rows from chats that are no longer allowlisted', async () => {
    const env = makeEnv()
    env.bridge.setAllowlist([OPS])
    await env.bridge.handleInbound(msg({ chat_id: OPS, text: 'PO-200 dispatched' }))
    expect((await env.app.inject({ method: 'GET', url: '/messages/search?q=PO-200' })).json().messages).toHaveLength(1)
    env.bridge.setAllowlist([])
    expect((await env.app.inject({ method: 'GET', url: '/messages/search?q=PO-200' })).json().messages).toHaveLength(0)
  })
})

describe('allowlist persistence + API', () => {
  it('PUT/GET /allowlist (HMAC) persists across restarts', async () => {
    const dbPath = path.join(root, 'persist.sqlite')
    const a = makeEnv({ dbPath })
    const unsigned = await a.app.inject({ method: 'PUT', url: '/allowlist', payload: JSON.stringify({ jids: [OPS] }), headers: { 'content-type': 'application/json' } })
    expect(unsigned.statusCode).toBe(401)
    expect((await a.app.inject({ method: 'GET', url: '/allowlist' })).statusCode).toBe(401)
    const put = await a.app.inject({ method: 'PUT', url: '/allowlist', ...signed({ jids: [OPS, '+91 98111-12222', '919811112222:7@s.whatsapp.net'] }) })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toEqual({ ok: true, jids: [OPS, APPROVER] })
    expect((await a.app.inject({ method: 'PUT', url: '/allowlist', ...signed({ jids: 'nope' }) })).statusCode).toBe(400)
    a.store.close()

    const b = makeEnv({ dbPath })
    const got = await b.app.inject({ method: 'GET', url: '/allowlist', ...signedGet() })
    expect(got.json()).toEqual({ jids: [OPS, APPROVER] })
    expect(b.bridge.isAllowed(OPS)).toBe(true)
    b.store.close()
  })

  it('demo/mock mode seeds the demo dispatch chat once; an explicit empty list is respected after restart', async () => {
    const dbPath = path.join(root, 'demo.sqlite')
    const a = makeEnv({ mock: true, dbPath })
    expect(a.bridge.getAllowlist()).toEqual([OPS, '919800000002@s.whatsapp.net'])
    a.bridge.setAllowlist([])
    a.store.close()
    const b = makeEnv({ mock: true, dbPath })
    expect(b.bridge.getAllowlist()).toEqual([])
    b.store.close()
    expect(makeEnv({ demoMode: true }).bridge.getAllowlist()).toContain(OPS)
    expect(makeEnv().bridge.getAllowlist()).toEqual([])
  })
})

describe('POST /send-internal', () => {
  let env: ReturnType<typeof makeEnv>
  beforeEach(async () => {
    env = makeEnv()
    env.bridge.setAllowlist([OPS, APPROVER])
    await open(env)
  })

  it('requires HMAC, sends to watched chats only, and never touches the gateway idempotency path', async () => {
    const body = { to: OPS, text: 'Got it ✓ Added to PO-184 (Example Customer)' }
    expect((await env.app.inject({ method: 'POST', url: '/send-internal', payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } })).statusCode).toBe(401)
    const ok = await env.app.inject({ method: 'POST', url: '/send-internal', ...signed(body) })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().message_id).toMatch(/^MOCK/)
    expect(env.mock.sent.at(-1)).toMatchObject({ jid: OPS, text: body.text })
    // a customer (not watched) cannot be reached through the team-only path
    const cust = await env.app.inject({ method: 'POST', url: '/send-internal', ...signed({ to: '+91 98000 00009', text: 'Please pay' }) })
    expect(cust.statusCode).toBe(403)
    expect(cust.json().error).toBe('recipient_not_allowlisted')
    expect((env.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency').get() as { n: number }).n).toBe(0)
    expect((await env.app.inject({ method: 'POST', url: '/send-internal', ...signed({ to: OPS }) })).statusCode).toBe(400)
  })

  it('is rate-limited by the shared limiter', async () => {
    const e = makeEnv({ rate: 1 })
    e.bridge.setAllowlist([OPS])
    await open(e)
    expect((await e.app.inject({ method: 'POST', url: '/send-internal', ...signed({ to: OPS, text: 'Which PO is this for?' }) })).statusCode).toBe(200)
    const limited = await e.app.inject({ method: 'POST', url: '/send-internal', ...signed({ to: OPS, text: 'Which PO is this for?' }) })
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBeDefined()
  })

  it('rejects approval prompts that are already expired or go to a group', async () => {
    const past = Math.floor(Date.now() / 1000) - 5
    const r1 = await env.app.inject({ method: 'POST', url: '/send-internal', ...signed({ to: APPROVER, text: 'x', approval: { id: 'ap-1', token: 'tok-12345678', expires_at: past } }) })
    expect(r1.statusCode).toBe(400)
    const r2 = await env.app.inject({ method: 'POST', url: '/send-internal', ...signed({ to: OPS, text: 'x', approval: { id: 'ap-1', token: 'tok-12345678', expires_at: past + 3600 } }) })
    expect(r2.statusCode).toBe(400)
    expect(env.store.getPendingApproval('919811112222')).toBeNull()
  })
})

describe('WhatsApp approval replies', () => {
  let env: ReturnType<typeof makeEnv>
  const prompt = 'PO-184 Example Customer: Rs 50,000 + GST 9,000 = Rs 59,000\nReply 1 to Approve, 2 to Reject, 3 for proof'
  const sendPrompt = (expires_at: number | string, id = 'ap-77', token = 'signed-token-abc') =>
    env.app.inject({ method: 'POST', url: '/send-internal', ...signed({ to: '+91 98111 12222', text: prompt, approval: { id, token, expires_at } }) })

  beforeEach(async () => {
    env = makeEnv()
    env.bridge.setAllowlist([OPS, APPROVER])
    await open(env)
  })

  it('parses choices', () => {
    expect(['1', ' 2. ', '3', 'Approve', 'reject!', 'PROOF'].map(parseApprovalChoice)).toEqual(['approve', 'reject', 'proof', 'approve', 'reject', 'proof'])
    expect(parseApprovalChoice('1 box short')).toBeNull()
    expect(parseApprovalChoice('12')).toBeNull()
  })

  it('maps "1" from the prompted phone to the API with the prompt token, answers the sender, consumes the prompt', async () => {
    expect((await sendPrompt(new Date(Date.now() + 600_000).toISOString())).statusCode).toBe(200)
    expect(env.store.getPendingApproval('919811112222')).toMatchObject({ approval_id: 'ap-77', token: 'signed-token-abc' })
    env.setApiAnswer({ ok: true, status: 200, reply: 'Done. Invoice INV-1042 created in Zoho and checked: Rs 59,000' })
    await env.bridge.handleInbound(msg({ chat_id: APPROVER, from: APPROVER, text: '1' }))
    expect(env.replies).toEqual([{ phone: '+919811112222', approval_id: 'ap-77', choice: 'approve', token: 'signed-token-abc' }])
    expect(env.mock.sent.at(-1)).toMatchObject({ jid: APPROVER, text: 'Done. Invoice INV-1042 created in Zoho and checked: Rs 59,000' })
    expect(env.store.getPendingApproval('919811112222')).toBeNull()
    // control replies are not stored as evidence nor forwarded as wa-events
    expect(env.store.count()).toBe(0)
    expect(env.events.filter((e) => e.type === 'message')).toHaveLength(0)
    // a second "1" has no pending prompt -> ordinary allowlisted message
    await env.bridge.handleInbound(msg({ chat_id: APPROVER, from: APPROVER, text: '1' }))
    expect(env.replies).toHaveLength(1)
    expect(env.store.count()).toBe(1)
  })

  it('"3"/"proof" keeps the prompt open so the approver can still answer 1/2', async () => {
    await sendPrompt(Math.floor(Date.now() / 1000) + 600)
    env.setApiAnswer({ ok: true, status: 200, reply: 'Proof: PO-184.pdf, delivery photo, sheet row 12' })
    await env.bridge.handleInbound(msg({ chat_id: APPROVER, from: APPROVER, text: 'proof' }))
    expect(env.replies.at(-1)).toMatchObject({ choice: 'proof', approval_id: 'ap-77' })
    expect(env.store.getPendingApproval('919811112222')).not.toBeNull()
    env.setApiAnswer({ ok: true, status: 200, reply: 'Rejected.' })
    await env.bridge.handleInbound(msg({ chat_id: APPROVER, from: APPROVER, text: '2' }))
    expect(env.replies.at(-1)).toMatchObject({ choice: 'reject' })
    expect(env.store.getPendingApproval('919811112222')).toBeNull()
  })

  it('a newer prompt replaces the older token for that phone', async () => {
    await sendPrompt(Math.floor(Date.now() / 1000) + 600, 'ap-1', 'token-old-1234')
    await sendPrompt(Math.floor(Date.now() / 1000) + 600, 'ap-2', 'token-new-5678')
    await env.bridge.handleInbound(msg({ chat_id: APPROVER, from: APPROVER, text: 'Approve' }))
    expect(env.replies.at(-1)).toMatchObject({ approval_id: 'ap-2', token: 'token-new-5678' })
  })

  it('expired prompt: API is not called, the approver is told it expired', async () => {
    await sendPrompt(Math.floor(Date.now() / 1000) + 600)
    env.store.db.prepare('UPDATE pending_approvals SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 1)
    await env.bridge.handleInbound(msg({ chat_id: APPROVER, from: APPROVER, text: '1' }))
    expect(env.replies).toHaveLength(0)
    expect(env.mock.sent.at(-1)).toMatchObject({ jid: APPROVER, text: APPROVAL_EXPIRED_TEXT })
    expect(env.store.getPendingApproval('919811112222')).toBeNull()
  })

  it('API refusal (4xx) forwards its text and ends the prompt; replies from other phones / groups / non-allowlisted chats are ignored', async () => {
    await sendPrompt(Math.floor(Date.now() / 1000) + 600)
    // "1" in the ops group from the approver: groups never approve
    await env.bridge.handleInbound(msg({ chat_id: OPS, from: APPROVER, text: '1' }))
    // another phone
    env.bridge.setAllowlist([OPS, APPROVER, '919833334444@s.whatsapp.net'])
    await env.bridge.handleInbound(msg({ chat_id: '919833334444@s.whatsapp.net', from: '919833334444@s.whatsapp.net', text: '1' }))
    expect(env.replies).toHaveLength(0)
    // approver removed from the allowlist -> dropped before anything
    env.bridge.setAllowlist([OPS])
    await env.bridge.handleInbound(msg({ chat_id: APPROVER, from: APPROVER, text: '1' }))
    expect(env.replies).toHaveLength(0)
    env.bridge.setAllowlist([OPS, APPROVER])
    env.setApiAnswer({ ok: false, status: 410, reply: 'This approval expired because the evidence changed. Here is the new one.' })
    await env.bridge.handleInbound(msg({ chat_id: APPROVER, from: APPROVER, text: '1' }))
    expect(env.replies).toHaveLength(1)
    expect(env.mock.sent.at(-1)!.text).toContain('evidence changed')
    expect(env.store.getPendingApproval('919811112222')).toBeNull()
  })
})

describe('chat picker: kinds, numbers and names', () => {
  it('tells people, groups, communities, announcement groups and channels apart', async () => {
    const env = makeEnv()
    const h = env.bridge.hooks()
    h.onChats!([
      { jid: '120363111@g.us', name: 'Traders Association', is_group: true, kind: 'community', members: 240 },
      { jid: '120363112@g.us', name: 'Traders Association', is_group: true, kind: 'announcement', parent: '120363111@g.us', members: 240 },
      { jid: '120363113@g.us', name: 'Hyderabad dealers', is_group: true, kind: 'group', parent: '120363111@g.us', members: 31 },
      { jid: '120363114@g.us', name: 'Dispatch', is_group: true, members: 8 },
      { jid: '120363999@newsletter', name: 'GST Updates', kind: 'channel' },
      { jid: 'status@broadcast', name: 'Status' },
    ])
    // a later plain update (no community flags) must not turn the community back into a group
    h.onChats!([{ jid: '120363111@g.us', name: 'Traders Association', is_group: true }])
    const rows = env.store.listChats()
    const by = Object.fromEntries(rows.map((r) => [r.jid, r]))
    expect(by['120363111@g.us']!.kind).toBe('community')
    expect(by['120363112@g.us']).toMatchObject({ kind: 'announcement', parent_name: 'Traders Association' })
    expect(by['120363113@g.us']).toMatchObject({ kind: 'group', members: 31, parent_name: 'Traders Association' })
    expect(by['120363114@g.us']).toMatchObject({ kind: 'group', members: 8 })
    expect(by['120363999@newsletter']).toMatchObject({ kind: 'channel', is_group: false, name: 'GST Updates' })
    expect(by['status@broadcast']).toBeUndefined()
  })

  it('shows the real phone number for a LID chat and prefers the saved name over the profile name', async () => {
    const env = makeEnv()
    const h = env.bridge.hooks()
    const LID = '81234567890123@lid'
    await env.bridge.handleInbound(msg({ chat_id: LID, from: '919876543204@s.whatsapp.net', from_name: '~ Ramu', ts: 1_760_000_900 }))
    let row = env.store.listChats().find((r) => r.jid === LID)!
    expect(row).toMatchObject({ kind: 'person', phone: '919876543204', name: '~ Ramu' })
    h.onContacts!([{ jid: '919876543204@s.whatsapp.net', name: 'Ramesh (Sri Lakshmi)' }])
    row = env.store.listChats().find((r) => r.jid === LID)!
    expect(row).toMatchObject({ name: 'Ramesh (Sri Lakshmi)', push_name: '~ Ramu', phone: '919876543204' })
  })

  it('a name that is only the number is dropped so the UI formats the number itself', async () => {
    const env = makeEnv()
    env.bridge.hooks().onChats!([{ jid: '919800000004@s.whatsapp.net', name: '+91 98000 00004' }])
    const row = env.store.listChats().find((r) => r.jid === '919800000004@s.whatsapp.net')!
    expect(row.name).toBeNull()
    expect(row.phone).toBe('919800000004')
  })

  it('links a LID to its phone number from contacts and lists only LIDs still unresolved', async () => {
    const env = makeEnv()
    const h = env.bridge.hooks()
    h.onChats!([{ jid: '111@lid' }, { jid: '222@lid' }])
    expect(h.unresolvedLids!().sort()).toEqual(['111@lid', '222@lid'])
    h.onContacts!([{ jid: '111@lid', phone_jid: '919800000111@s.whatsapp.net' }])
    expect(h.unresolvedLids!()).toEqual(['222@lid'])
    expect(env.store.listChats().find((r) => r.jid === '111@lid')!.phone).toBe('919800000111')
  })

  it('shows one row when a person has both a phone-number chat and a LID chat, and either JID lets messages in', async () => {
    const env = makeEnv()
    const h = env.bridge.hooks()
    h.onChats!([{ jid: '919834149243@s.whatsapp.net', name: 'Mom', last_message_at: 1_760_000_100 }, { jid: '555@lid', last_message_at: 1_760_000_900 }])
    h.onContacts!([{ jid: '555@lid', phone_jid: '919834149243@s.whatsapp.net' }])
    const moms = env.store.listChats().filter((r) => r.phone === '919834149243')
    expect(moms).toHaveLength(1)
    expect(moms[0]).toMatchObject({ jid: '919834149243@s.whatsapp.net', name: 'Mom', last_message_at: 1_760_000_900, aliases: ['555@lid'] })
    env.bridge.setAllowlist(['919834149243@s.whatsapp.net'])
    expect(env.bridge.isAllowed('555@lid')).toBe(true)
    env.bridge.setAllowlist(['555@lid'])
    expect(env.bridge.isAllowed('919834149243@s.whatsapp.net')).toBe(true)
    expect(env.bridge.isAllowed('919800000000@s.whatsapp.net')).toBe(false)
  })
})
