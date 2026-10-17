import { describe, expect, it } from 'vitest'
import { AllProvidersFailedError, CircuitBreaker, ModelRouter, OpenAICompatProvider, type ModelProvider } from '../src/plugins/model-router.js'
import type { ModelRequest } from '../src/core/types.js'
import { buildProviders } from '../src/runner.js'
import { testConfig } from './helpers.js'

function fakeProvider(name: string, behaviour: () => 'ok' | 'fail', calls: string[]): ModelProvider {
  return {
    name,
    model: `${name}-model`,
    costInr: (u) => (u.input_tokens + u.output_tokens) / 1000,
    async call() {
      calls.push(name)
      if (behaviour() === 'fail') throw new Error(`${name} down`)
      return { content: `{"from":"${name}"}`, tool_calls: [], usage: { input_tokens: 10, output_tokens: 5 } }
    },
  }
}
const req = (): ModelRequest => ({ messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal, agent: 'triage' })

describe('model router fallback NIM -> Groq -> Ollama', () => {
  it('falls back in order and reports which providers failed', async () => {
    const calls: string[] = []
    const r = new ModelRouter([fakeProvider('nim', () => 'fail', calls), fakeProvider('groq', () => 'fail', calls), fakeProvider('ollama', () => 'ok', calls)], { timeoutMs: 1000, breakerThreshold: 3, breakerCooldownMs: 60_000 })
    const res = await r.chat(req())
    expect(res.provider).toBe('ollama')
    expect(res.fallbacks.map((f) => f.provider)).toEqual(['nim', 'groq'])
    expect(calls).toEqual(['nim', 'groq', 'ollama'])
    expect(res.cost_inr).toBeCloseTo(0.015)
  })

  it('uses the primary when healthy', async () => {
    const calls: string[] = []
    const r = new ModelRouter([fakeProvider('nim', () => 'ok', calls), fakeProvider('groq', () => 'ok', calls)], { timeoutMs: 1000, breakerThreshold: 3, breakerCooldownMs: 60_000 })
    expect((await r.chat(req())).provider).toBe('nim')
    expect(calls).toEqual(['nim'])
  })

  it('circuit breaker opens after N failures and skips the provider without calling it', async () => {
    const calls: string[] = []
    const r = new ModelRouter([fakeProvider('nim', () => 'fail', calls), fakeProvider('groq', () => 'ok', calls)], { timeoutMs: 1000, breakerThreshold: 2, breakerCooldownMs: 60_000 })
    await r.chat(req())
    await r.chat(req())
    expect(r.breakers.get('nim')!.state).toBe('open')
    calls.length = 0
    const res = await r.chat(req())
    expect(calls).toEqual(['groq'])
    expect(res.fallbacks).toEqual([{ provider: 'nim', error: 'circuit_open' }])
  })

  it('throws AllProvidersFailedError when every provider fails', async () => {
    const r = new ModelRouter([fakeProvider('nim', () => 'fail', [])], { timeoutMs: 1000, breakerThreshold: 3, breakerCooldownMs: 1 })
    await expect(r.chat(req())).rejects.toBeInstanceOf(AllProvidersFailedError)
  })

  it('a cancelled run does not trip the breaker', async () => {
    const ac = new AbortController()
    const slow: ModelProvider = { name: 'nim', model: 'm', costInr: () => 0, call: (_r, signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) }
    const r = new ModelRouter([slow], { timeoutMs: 10_000, breakerThreshold: 1, breakerCooldownMs: 60_000 })
    const p = r.chat({ ...req(), signal: ac.signal })
    ac.abort(new Error('budget'))
    await expect(p).rejects.toThrow()
    expect(r.breakers.get('nim')!.state).toBe('closed')
  })
})

describe('circuit breaker', () => {
  it('closed -> open -> half_open (one trial) -> closed', () => {
    let t = 0
    const b = new CircuitBreaker(2, 1000, () => t)
    b.failure()
    expect(b.state).toBe('closed')
    b.failure()
    expect(b.state).toBe('open')
    expect(b.allow()).toBe(false)
    t = 1000
    expect(b.state).toBe('half_open')
    expect(b.allow()).toBe(true)
    expect(b.allow()).toBe(false) // only one trial in flight
    b.success()
    expect(b.state).toBe('closed')
  })
  it('half-open failure re-opens immediately', () => {
    let t = 0
    const b = new CircuitBreaker(5, 100, () => t)
    for (let i = 0; i < 5; i++) b.failure()
    t = 100
    expect(b.allow()).toBe(true)
    b.failure()
    expect(b.state).toBe('open')
  })
})

describe('OpenAI-compatible provider + env config', () => {
  it('maps the request/response and computes INR cost', async () => {
    let sent: Record<string, unknown> = {}
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'x1', type: 'function', function: { name: 'laya_decide', arguments: '{"state":"s"}' } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }), { status: 200 })
    }) as unknown as typeof fetch
    const p = new OpenAICompatProvider({ name: 'nim', baseUrl: 'http://nim', apiKey: 'k', model: 'deepseek-ai/deepseek-v4.1-flash', enabled: true, costInPerMTok: 25, costOutPerMTok: 100 }, { temperature: 0.1, maxOutputTokens: 512 }, fetchImpl)
    const r = await p.call({ ...req(), tools: [{ type: 'function', function: { name: 'laya_decide', description: 'd', parameters: {} } }] }, new AbortController().signal)
    expect(sent.model).toBe('deepseek-ai/deepseek-v4.1-flash')
    expect(sent.tool_choice).toBe('auto')
    expect(r.tool_calls[0]!.function.name).toBe('laya_decide')
    expect(p.costInr(r.usage)).toBeCloseTo(0.035)
  })
  it('model names and order are env-configurable; disabled providers are skipped', () => {
    const cfg = testConfig({ MOCK_LLM: 'false', NVIDIA_API_KEY: 'n', GROQ_API_KEY: 'g', OLLAMA_DISABLED: 'false', NIM_MODEL: 'custom/nim', GROQ_MODEL: 'custom/groq', OLLAMA_MODEL: 'custom:ollama', LLM_PROVIDER_ORDER: 'groq,nim,ollama' })
    expect(buildProviders(cfg).map((p) => `${p.name}:${p.model}`)).toEqual(['groq:custom/groq', 'nim:custom/nim', 'ollama:custom:ollama'])
    const noKeys = testConfig({ MOCK_LLM: 'false' })
    expect(buildProviders(noKeys).map((p) => p.name)).toEqual([])
  })
})
