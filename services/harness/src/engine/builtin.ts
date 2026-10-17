/**
 * HARNESS_ENGINE=builtin: a minimal agent loop implementing the same plugin interfaces as the dsh engine
 * (model adapter -> tool registry -> tool policy waterfall -> post-execute -> session log). Used when the
 * dsh packages are unavailable, and as a reference implementation for tests.
 * step = one model request plus the tools it calls (same definition as dsh).
 */
import type { Pipeline } from '../core/pipeline.js'
import type { RunContext } from '../core/run-context.js'
import type { ChatMessage, ModelClient } from '../core/types.js'
import { AllProvidersFailedError } from '../plugins/model-router.js'
import type { Engine, EngineResult, EngineSession } from './types.js'

export class BuiltinEngine implements Engine {
  readonly name = 'builtin' as const

  async open(run: RunContext, deps: { pipeline: Pipeline; model: ModelClient; systemPrompt: string; maxOutputTokens: number }): Promise<EngineSession> {
    const messages: ChatMessage[] = [{ role: 'system', content: deps.systemPrompt }]
    const tools = deps.pipeline.toolSchemasFor(run.agent)
    return {
      async send(userText: string): Promise<EngineResult> {
        messages.push({ role: 'user', content: userText })
        for (;;) {
          const gate = deps.pipeline.gateModel(run)
          if (gate) return { text: null, stopped: { reason: gate.stop, detail: gate.detail } }
          if (run.signal.aborted) return { text: null, stopped: { reason: run.stop?.reason ?? 'cancelled', detail: run.stop?.detail ?? 'aborted' } }
          deps.pipeline.step(run, 'start')
          let res
          try {
            res = await deps.model.chat({
              messages,
              tools,
              signal: run.signal,
              agent: run.agent,
              maxOutputTokens: deps.maxOutputTokens,
              remainingMs: run.budget.max_seconds * 1000 - run.elapsedMs,
            } as Parameters<ModelClient['chat']>[0])
          } catch (err) {
            deps.pipeline.step(run, 'end', 0)
            if (run.signal.aborted) return { text: null, stopped: { reason: run.stop?.reason ?? 'cancelled', detail: run.stop?.detail ?? 'aborted' } }
            if (err instanceof AllProvidersFailedError) return { text: null, error: { reason: 'llm_unavailable', detail: err.message } }
            return { text: null, error: { reason: 'error', detail: (err as Error).message } }
          }
          deps.pipeline.afterModel(run, res)
          messages.push({ role: 'assistant', content: res.content, ...(res.tool_calls.length ? { tool_calls: res.tool_calls } : {}) })
          if (res.tool_calls.length === 0) {
            deps.pipeline.step(run, 'end', 0)
            return { text: res.content }
          }
          for (const tc of res.tool_calls) {
            let args: Record<string, unknown> = {}
            try {
              const parsed = JSON.parse(tc.function.arguments || '{}')
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
            } catch {
              /* invalid JSON args -> empty; the API validates */
            }
            const outcome = await deps.pipeline.handleToolCall(run, { id: tc.id, name: tc.function.name, args })
            messages.push({ role: 'tool', tool_call_id: tc.id, content: outcome.text })
          }
          deps.pipeline.step(run, 'end', res.tool_calls.length)
        }
      },
      async dispose() {},
    }
  }
}
