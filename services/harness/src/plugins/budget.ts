/** (g) Budget plugin: max_steps, max_tokens, max_seconds, max_cost_inr. Stops the loop with stop_reason "budget". */
import type { Budget } from '../contract.js'
import type { ModelGate, RgPlugin } from '../core/plugin.js'
import type { RunContext } from '../core/run-context.js'
import type { ModelResponse } from '../core/types.js'

export interface BudgetUsage {
  steps: number
  tokens: number
  elapsedMs: number
  costInr: number
}

/** Returns a violation description, or undefined when another model call is allowed. */
export function checkBudget(b: Budget, u: BudgetUsage, opts: { ignoreSteps?: boolean } = {}): string | undefined {
  if (!opts.ignoreSteps && u.steps >= b.max_steps) return `max_steps reached (${u.steps}/${b.max_steps})`
  if (u.tokens >= b.max_tokens) return `max_tokens reached (${u.tokens}/${b.max_tokens})`
  if (u.elapsedMs >= b.max_seconds * 1000) return `max_seconds reached (${(u.elapsedMs / 1000).toFixed(1)}s/${b.max_seconds}s)`
  if (u.costInr >= b.max_cost_inr) return `max_cost_inr reached (₹${u.costInr.toFixed(4)}/₹${b.max_cost_inr})`
  return undefined
}

export class BudgetPlugin implements RgPlugin {
  readonly name = 'budget'

  beforeModel(run: RunContext): ModelGate {
    if (run.stop?.reason === 'budget') return { stop: 'budget', detail: run.stop.detail }
    const v = checkBudget(
      run.budget,
      { steps: run.step, tokens: run.totalTokens, elapsedMs: run.elapsedMs, costInr: run.costInr },
      // output-repair retries (≤2) are bounded separately; they still consume tokens/time/cost
      { ignoreSteps: run.repairing },
    )
    if (!v) return undefined
    run.requestStop('budget', v)
    return { stop: 'budget', detail: v }
  }

  afterModel(run: RunContext, res: ModelResponse): void {
    run.modelCalls += 1
    run.tokensIn += res.usage.input_tokens
    run.tokensOut += res.usage.output_tokens
    run.costInr += res.cost_inr
    run.providersUsed.add(res.provider)
  }

  /** Wall-clock budget: aborts in-flight model/tool calls when max_seconds elapses. */
  static armTimer(run: RunContext): () => void {
    const t = setTimeout(() => {
      run.requestStop('budget', `max_seconds reached (${run.budget.max_seconds}s)`)
      run.cancel('budget:max_seconds')
    }, run.budget.max_seconds * 1000)
    t.unref()
    return () => clearTimeout(t)
  }
}
