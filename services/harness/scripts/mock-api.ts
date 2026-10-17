/**
 * Tiny stand-in for services/api, for local testing of harness + wa-bridge ONLY (not the real API).
 *  - POST /tools/<name>           HMAC-verified, re-checks X-RG-Agent allow-list, serves PO-184 fixtures
 *  - POST /internal/agent-events  HMAC-verified, records events
 *  - POST /internal/wa-events     HMAC-verified, records wa-bridge events
 *  - POST /mock/scenario {correction:boolean}   toggles the "Correction: 70 delivered" WhatsApp message
 *  - GET  /mock/events            everything recorded
 * Run: INTERNAL_HMAC_SECRET=dev PORT=8000 npx tsx scripts/mock-api.ts
 */
import Fastify from 'fastify'
import { TOOL_ALLOW_LIST, type AgentName } from '../src/contract.js'
import { verifySignature } from '../src/hmac.js'
import { fixtures, scenario } from './fixtures.js'

const secret = process.env.INTERNAL_HMAC_SECRET ?? 'dev'
const port = Number(process.env.PORT ?? 8000)
const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 })
scenario.correction = process.env.MOCK_API_CORRECTION === 'true'
const state = { agentEvents: [] as unknown[], waEvents: [] as unknown[], toolCalls: [] as unknown[], rejected: [] as unknown[] }

app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  ;(req as unknown as { rawBody: Buffer }).rawBody = body as Buffer
  try {
    done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString()) : {})
  } catch (e) {
    done(e as Error, undefined)
  }
})

app.addHook('preHandler', async (req, reply) => {
  if (req.method !== 'POST' || req.url.startsWith('/mock/')) return
  const v = verifySignature((req as unknown as { rawBody: Buffer }).rawBody, req.headers['x-rg-signature'] as string, req.headers['x-rg-timestamp'] as string, secret)
  if (!v.ok) {
    state.rejected.push({ url: req.url, reason: v.reason })
    return reply.code(401).send({ ok: false, error: v.reason })
  }
})

app.post('/tools/:name', async (req, reply) => {
  const name = (req.params as { name: string }).name
  const agent = req.headers['x-rg-agent'] as AgentName | undefined
  const body = req.body as { case_id: string; correlation_id: string; args: Record<string, unknown> }
  state.toolCalls.push({ name, agent, body })
  if (!agent || !TOOL_ALLOW_LIST[agent]?.includes(name)) return reply.code(403).send({ ok: false, error: `agent ${agent} not allowed to call ${name}` })
  return { ok: true, ...fixtures(name, body.args ?? {}) }
})
app.post('/internal/agent-events', async (req) => {
  state.agentEvents.push(req.body)
  return { ok: true }
})
app.post('/internal/wa-events', async (req) => {
  const b = req.body as Record<string, unknown>
  const m = b.message as { media?: { base64?: string } } | undefined
  state.waEvents.push(m?.media?.base64 ? { ...b, message: { ...m, media: { ...m.media, base64: `[${m.media.base64.length} b64 chars]` } } } : b)
  return { ok: true }
})
app.post('/mock/scenario', async (req) => {
  scenario.correction = !!(req.body as { correction?: boolean }).correction
  return { ok: true, correction: scenario.correction }
})
app.post('/mock/reset', async () => {
  state.agentEvents.length = 0
  state.waEvents.length = 0
  state.toolCalls.length = 0
  state.rejected.length = 0
  return { ok: true }
})
app.get('/mock/events', async () => ({ ...state, correction: scenario.correction }))

app.listen({ port, host: '0.0.0.0' }).then(() => console.log(`mock-api listening on :${port}`))
