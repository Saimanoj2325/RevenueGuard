import { describe, expect, it } from 'vitest'
import { BudgetPlugin, checkBudget } from '../src/plugins/budget.js'
import { mkRun } from './helpers.js'

const b = { max_steps: 3, max_tokens: 1000, max_seconds: 10, max_cost_inr: 1 }
const ok = { steps: 0, tokens: 0, elapsedMs: 0, costInr: 0 }

describe('budget plugin', () => {
  it('checks every dimension', () => {
    expect(checkBudget(b, ok)).toBeUndefined()
    expect(checkBudget(b, { ...ok, steps: 3 })).toMatch(/max_steps/)
    expect(checkBudget(b, { ...ok, tokens: 1000 })).toMatch(/max_tokens/)
    expect(checkBudget(b, { ...ok, elapsedMs: 10_000 })).toMatch(/max_seconds/)
    expect(checkBudget(b, { ...ok, costInr: 1 })).toMatch(/max_cost_inr/)
    expect(checkBudget(b, { ...ok, steps: 3 }, { ignoreSteps: true })).toBeUndefined()
  })
  it('gates model calls, accumulates usage and records stop_reason budget', () => {
    const p = new BudgetPlugin()
    const { run } = mkRun('investigation', { max_steps: 8, max_tokens: 100 })
    expect(p.beforeModel(run)).toBeUndefined()
    p.afterModel(run, { content: null, tool_calls: [], usage: { input_tokens: 80, output_tokens: 30 }, provider: 'nim', model: 'm', latency_ms: 1, cost_inr: 0.01, fallbacks: [] })
    expect(run.totalTokens).toBe(110)
    expect(run.costInr).toBeCloseTo(0.01)
    expect(p.beforeModel(run)).toMatchObject({ stop: 'budget' })
    expect(run.stop).toMatchObject({ reason: 'budget' })
  })
  it('wall-clock timer aborts the run', async () => {
    const { run } = mkRun('triage', { max_seconds: 0.05 })
    const disarm = BudgetPlugin.armTimer(run)
    await new Promise((r) => setTimeout(r, 120))
    disarm()
    expect(run.signal.aborted).toBe(true)
    expect(run.stop?.reason).toBe('budget')
  })
})
