import { loadConfig } from '../src/config.js'
import { RunContext } from '../src/core/run-context.js'
import type { AgentEvent, AgentName, Budget } from '../src/contract.js'
import { fixtures, scenario } from '../scripts/fixtures.js'
import { TOOL_ALLOW_LIST } from '../src/contract.js'
import { pino } from 'pino'

export const silent = pino({ level: 'silent' })
export const SECRET = 'test-secret'

export function testConfig(over: Record<string, string> = {}) {
  return loadConfig({ INTERNAL_HMAC_SECRET: SECRET, API_URL: 'http://api.test', MOCK_LLM: 'true', OLLAMA_DISABLED: 'true', ...over })
}

export function mkRun(agent: AgentName, budget: Partial<Budget> = {}, input: Record<string, unknown> = {}) {
  const events: { type: string; data: Record<string, unknown> }[] = []
  const run = new RunContext('run-1', 'RG-1042', 'corr-1', agent, input, { max_steps: 8, max_tokens: 40000, max_seconds: 120, max_cost_inr: 5, ...budget }, (type, data) => events.push({ type, data }))
  return { run, events }
}

/** In-process fake of the API: /tools/* fixtures (with allow-list re-check) + /internal/agent-events capture. */
export function fakeApi(opts: { correction?: boolean; override?: Record<string, unknown> } = {}) {
  const events: AgentEvent[] = []
  const toolCalls: { name: string; agent: string; args: unknown }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    scenario.correction = !!opts.correction
    const u = new URL(String(url))
    const body = JSON.parse(String(init?.body ?? '{}'))
    const headers = new Headers(init?.headers)
    if (!headers.get('x-rg-signature')?.startsWith('sha256=')) return new Response(JSON.stringify({ ok: false }), { status: 401 })
    if (u.pathname === '/internal/agent-events') {
      events.push(body)
      return new Response('{"ok":true}', { status: 200 })
    }
    const m = u.pathname.match(/^\/tools\/(.+)$/)
    if (m) {
      const name = decodeURIComponent(m[1]!)
      const agent = headers.get('x-rg-agent') as AgentName
      toolCalls.push({ name, agent, args: body.args })
      if (!TOOL_ALLOW_LIST[agent]?.includes(name)) return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403 })
      const fx = (opts.override?.[name] as object | undefined) ?? fixtures(name, body.args ?? {})
      return new Response(JSON.stringify({ ok: true, ...fx }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, events, toolCalls }
}
