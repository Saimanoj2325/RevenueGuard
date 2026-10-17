/**
 * (f) Event-sink plugin: forwards step/tool/model/run events to POST {API_URL}/internal/agent-events (HMAC).
 * Delivery is ordered per process (single queue), retried with backoff, and never blocks the agent loop;
 * the runner flushes the queue (bounded) before answering /agents/run so run_finished lands first.
 */
import type { AgentEvent, AgentEventType } from '../contract.js'
import { signedHeaders } from '../hmac.js'
import type { RgPlugin } from '../core/plugin.js'
import type { RunContext } from '../core/run-context.js'
import type { ModelResponse } from '../core/types.js'
import type { Logger } from '../logger.js'

export class EventSink {
  private queue: AgentEvent[] = []
  private draining: Promise<void> | undefined
  private seqByRun = new Map<string, number>()
  posted = 0
  dropped = 0
  /** last N events kept in memory for GET /runs/:id/events debugging */
  readonly recent: AgentEvent[] = []

  constructor(
    private readonly apiUrl: string,
    private readonly secret: string,
    private readonly log: Logger,
    private readonly enabled = true,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  emitter(run: { runId: string; caseId: string; correlationId: string; agent: AgentEvent['agent'] }) {
    return (type: AgentEventType, data: Record<string, unknown>) => {
      const seq = (this.seqByRun.get(run.runId) ?? 0) + 1
      this.seqByRun.set(run.runId, seq)
      const ev: AgentEvent = { run_id: run.runId, case_id: run.caseId, type, agent: run.agent, data, ts: new Date().toISOString(), correlation_id: run.correlationId, seq }
      this.recent.push(ev)
      if (this.recent.length > 2000) this.recent.shift()
      if (type === 'run_finished' || type === 'run_failed') this.seqByRun.delete(run.runId)
      if (!this.enabled) return
      this.queue.push(ev)
      this.kick()
    }
  }

  private kick(): void {
    if (this.draining) return
    this.draining = (async () => {
      while (this.queue.length) {
        const ev = this.queue.shift()!
        await this.post(ev)
      }
    })().finally(() => {
      this.draining = undefined
      if (this.queue.length) this.kick()
    })
  }

  private async post(ev: AgentEvent): Promise<void> {
    const body = JSON.stringify(ev)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.apiUrl}/internal/agent-events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...signedHeaders(body, this.secret) },
          body,
          signal: AbortSignal.timeout(5000),
        })
        if (res.ok) {
          this.posted++
          return
        }
        if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) break
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt))
    }
    this.dropped++
    this.log.warn({ run_id: ev.run_id, type: ev.type, seq: ev.seq }, 'agent event delivery failed')
  }

  /** Wait (bounded) until queued events are delivered. */
  async flush(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while ((this.queue.length || this.draining) && Date.now() < deadline) {
      await Promise.race([this.draining ?? Promise.resolve(), new Promise((r) => setTimeout(r, 50))])
    }
  }
}

/** Plugin face of the sink: model_call and step events. Tool events are emitted by the pipeline. */
export class EventSinkPlugin implements RgPlugin {
  readonly name = 'event-sink'

  afterModel(run: RunContext, res: ModelResponse): void {
    run.emit('model_call', {
      step: run.step,
      provider: res.provider,
      model: res.model,
      latency_ms: res.latency_ms,
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
      cost_inr: res.cost_inr,
      tool_calls: res.tool_calls.map((t) => t.function.name),
      ...(res.fallbacks.length ? { fallback_from: res.fallbacks } : {}),
      repair: run.repairing || undefined,
    })
  }

  onStep(run: RunContext, phase: 'start' | 'end', info: { step: number; toolCalls?: number }): void {
    if (phase === 'start') run.emit('step_started', { step: info.step, repair: run.repairing || undefined })
    else run.emit('step_finished', { step: info.step, tool_calls: info.toolCalls ?? 0 })
  }
}
