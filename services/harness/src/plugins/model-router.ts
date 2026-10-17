/**
 * (a) Model adapter plugin: OpenAI-compatible router NIM (DeepSeek V4) -> Groq -> Ollama.
 *  - every provider is an OpenAI-compatible /chat/completions endpoint; model names come from env
 *  - per-provider circuit breaker (closed -> open after N consecutive failures -> half-open after cooldown)
 *  - per-call timeout bounded by the run's remaining max_seconds budget; run abort cancels in-flight calls
 *  - token usage + INR cost reported per call (the budget plugin accumulates and enforces)
 */
import type { ProviderConfig } from '../config.js'
import type { ChatMessage, ModelClient, ModelRequest, ModelResponse, ModelUsage, ChatToolCall } from '../core/types.js'
import type { Logger } from '../logger.js'

export type BreakerState = 'closed' | 'open' | 'half_open'

export class CircuitBreaker {
  private failures = 0
  private openedAt = 0
  private halfOpenInFlight = false
  private _state: BreakerState = 'closed'

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): BreakerState {
    if (this._state === 'open' && this.now() - this.openedAt >= this.cooldownMs) this._state = 'half_open'
    return this._state
  }

  /** May a request go through right now? (half-open admits one trial request) */
  allow(): boolean {
    const st = this.state
    if (st === 'closed') return true
    if (st === 'half_open' && !this.halfOpenInFlight) {
      this.halfOpenInFlight = true
      return true
    }
    return false
  }

  success(): void {
    this.failures = 0
    this.halfOpenInFlight = false
    this._state = 'closed'
  }

  failure(): void {
    this.halfOpenInFlight = false
    this.failures += 1
    if (this._state === 'half_open' || this.failures >= this.threshold) {
      this._state = 'open'
      this.openedAt = this.now()
    }
  }
}

export interface ProviderCallResult {
  content: string | null
  tool_calls: ChatToolCall[]
  usage: ModelUsage
}

export interface ModelProvider {
  readonly name: string
  readonly model: string
  costInr(usage: ModelUsage): number
  call(req: ModelRequest, signal: AbortSignal): Promise<ProviderCallResult>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export class OpenAICompatProvider implements ModelProvider {
  readonly name: string
  readonly model: string
  constructor(
    private readonly cfg: ProviderConfig,
    private readonly opts: { temperature: number; maxOutputTokens: number },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.name = cfg.name
    this.model = cfg.model
  }

  costInr(u: ModelUsage): number {
    return (u.input_tokens * this.cfg.costInPerMTok + u.output_tokens * this.cfg.costOutPerMTok) / 1_000_000
  }

  async call(req: ModelRequest, signal: AbortSignal): Promise<ProviderCallResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: req.messages.map(toWire),
      temperature: this.opts.temperature,
      max_tokens: req.maxOutputTokens ?? this.opts.maxOutputTokens,
      stream: false,
    }
    if (req.tools.length) {
      body.tools = req.tools
      body.tool_choice = 'auto'
    }
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ProviderError(`${this.name} http_${res.status}: ${text.slice(0, 200)}`, res.status)
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: ChatToolCall[] } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const msg = json.choices?.[0]?.message
    if (!msg) throw new ProviderError(`${this.name}: empty choices`)
    const tool_calls = (msg.tool_calls ?? []).map((t, i) => ({
      id: t.id || `call_${i}_${Date.now()}`,
      type: 'function' as const,
      function: { name: t.function?.name ?? '', arguments: typeof t.function?.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function?.arguments ?? {}) },
    }))
    const content = stripThink(msg.content ?? null)
    if (!content && tool_calls.length === 0) throw new ProviderError(`${this.name}: empty response`)
    return {
      content,
      tool_calls,
      usage: { input_tokens: json.usage?.prompt_tokens ?? estimateTokens(req.messages), output_tokens: json.usage?.completion_tokens ?? Math.ceil((content ?? '').length / 4) },
    }
  }
}

function toWire(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'assistant') return { role: 'assistant', content: m.content ?? '', ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) }
  return { ...m }
}

/** qwen3 / reasoning models may inline <think>…</think>; it is not part of the answer. */
function stripThink(s: string | null): string | null {
  if (!s) return s
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0) / 4)
}

export class AllProvidersFailedError extends Error {
  constructor(readonly attempts: { provider: string; error: string }[]) {
    super(`llm_unavailable: ${attempts.map((a) => `${a.provider}: ${a.error}`).join('; ') || 'no providers enabled'}`)
  }
}

export class ModelRouter implements ModelClient {
  readonly breakers = new Map<string, CircuitBreaker>()

  constructor(
    readonly providers: ModelProvider[],
    private readonly opts: { timeoutMs: number; breakerThreshold: number; breakerCooldownMs: number; remainingMs?: () => number },
    private readonly log?: Logger,
  ) {
    for (const p of providers) this.breakers.set(p.name, new CircuitBreaker(opts.breakerThreshold, opts.breakerCooldownMs))
  }

  status() {
    return this.providers.map((p) => ({ provider: p.name, model: p.model, breaker: this.breakers.get(p.name)!.state }))
  }

  async chat(req: ModelRequest & { remainingMs?: number }): Promise<ModelResponse> {
    const fallbacks: { provider: string; error: string }[] = []
    for (const p of this.providers) {
      const br = this.breakers.get(p.name)!
      if (!br.allow()) {
        fallbacks.push({ provider: p.name, error: 'circuit_open' })
        continue
      }
      if (req.signal.aborted) throw req.signal.reason ?? new Error('aborted')
      const timeout = Math.max(1000, Math.min(this.opts.timeoutMs, req.remainingMs ?? Number.POSITIVE_INFINITY))
      const started = Date.now()
      try {
        const r = await p.call(req, AbortSignal.any([req.signal, AbortSignal.timeout(timeout)]))
        br.success()
        return { ...r, provider: p.name, model: p.model, latency_ms: Date.now() - started, cost_inr: p.costInr(r.usage), fallbacks }
      } catch (err) {
        if (req.signal.aborted) throw req.signal.reason ?? err // run cancelled (budget/time): not the provider's fault
        br.failure()
        const msg = (err as Error).name === 'TimeoutError' ? 'timeout' : (err as Error).message
        fallbacks.push({ provider: p.name, error: msg.slice(0, 300) })
        this.log?.warn({ provider: p.name, error: msg.slice(0, 200), breaker: br.state }, 'llm provider failed; falling back')
      }
    }
    throw new AllProvidersFailedError(fallbacks)
  }
}
