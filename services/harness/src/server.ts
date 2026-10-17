import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { RunRequestSchema, TOOL_ALLOW_LIST } from './contract.js'
import { SIG_HEADER, TS_HEADER, verifySignature } from './hmac.js'
import type { RunResponse, Runner } from './runner.js'

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer
  }
}

export function buildServer(runner: Runner): FastifyInstance {
  const { cfg, log } = runner
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 })
  const startedAt = Date.now()
  const inflight = new Map<string, Promise<RunResponse>>()
  const done = new Map<string, RunResponse>() // run_id idempotency (API retries must not double-run)

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, cb) => {
    req.rawBody = body as Buffer
    if ((body as Buffer).length === 0) return cb(null, {})
    try {
      cb(null, JSON.parse((body as Buffer).toString('utf8')))
    } catch {
      const e = new Error('invalid_json') as Error & { statusCode: number }
      e.statusCode = 400
      cb(e, undefined)
    }
  })

  const requireHmac = async (req: FastifyRequest, reply: FastifyReply) => {
    const v = verifySignature(req.rawBody ?? Buffer.alloc(0), req.headers[SIG_HEADER] as string | undefined, req.headers[TS_HEADER] as string | undefined, cfg.hmacSecret, cfg.hmacMaxSkewSec)
    if (!v.ok) {
      log.warn({ path: req.url, reason: v.reason }, 'hmac rejected')
      return reply.code(401).send({ ok: false, error: 'unauthorized', reason: v.reason })
    }
  }

  app.get('/health', async () => ({
    ok: true,
    service: 'harness',
    engine: runner.engine,
    engine_requested: cfg.engine,
    dsh: runner.dshStatus,
    mock_llm: cfg.mockLlm,
    providers: runner.router.status(),
    inflight: inflight.size,
    events: { posted: runner.sink.posted, dropped: runner.sink.dropped },
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
  }))

  app.get('/agents', async () => ({ agents: Object.entries(TOOL_ALLOW_LIST).map(([name, tools]) => ({ name, tools })) }))

  app.get('/policy/denials', async () => ({ denials: runner.policy.denials.slice(-100) }))

  app.get('/runs/:id/events', async (req) => {
    const id = (req.params as { id: string }).id
    return { events: runner.sink.recent.filter((e) => e.run_id === id) }
  })

  app.post('/agents/run', { preHandler: requireHmac }, async (req, reply) => {
    const parsed = RunRequestSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_body', issues: parsed.error.issues })
    const r = parsed.data
    const prev = done.get(r.run_id)
    if (prev) return { ...prev, replayed: true }
    const running = inflight.get(r.run_id)
    if (running) return { ...(await running), replayed: true }
    if (inflight.size >= cfg.maxConcurrentRuns) return reply.code(429).send({ ok: false, error: 'too_many_runs', inflight: inflight.size })
    log.info({ run_id: r.run_id, case_id: r.case_id, agent: r.agent, engine: runner.engine }, 'agent run started')
    const p = runner.run(r)
    inflight.set(r.run_id, p)
    try {
      const res = await p
      done.set(r.run_id, res)
      if (done.size > 1000) done.delete(done.keys().next().value as string)
      log.info({ run_id: r.run_id, status: res.status, reason: res.reason, repairs: res.repairs, usage: res.usage }, 'agent run finished')
      return res
    } finally {
      inflight.delete(r.run_id)
    }
  })

  return app
}
