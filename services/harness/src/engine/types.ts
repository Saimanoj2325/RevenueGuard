import type { RunContext } from '../core/run-context.js'
import type { Pipeline } from '../core/pipeline.js'
import type { ModelClient } from '../core/types.js'

export interface EngineResult {
  /** final assistant text (expected to be the JSON output) */
  text: string | null
  /** set when the loop stopped early (budget, cancel) */
  stopped?: { reason: string; detail: string }
  /** provider failure that ended the run */
  error?: { reason: 'llm_unavailable' | 'error'; detail: string }
}

/**
 * An engine session: one agent conversation that can be continued (output repairs append a user turn).
 * HARNESS_ENGINE=dsh -> DshEngine (dsh-adapter.ts); HARNESS_ENGINE=builtin -> BuiltinEngine.
 */
export interface EngineSession {
  send(userText: string): Promise<EngineResult>
  dispose(): Promise<void>
}

export interface Engine {
  readonly name: 'dsh' | 'builtin'
  open(run: RunContext, deps: { pipeline: Pipeline; model: ModelClient; systemPrompt: string; maxOutputTokens: number }): Promise<EngineSession>
}
