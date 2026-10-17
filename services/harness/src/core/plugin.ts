/**
 * RevenueGuard plugin interface. It mirrors the dsh/Cordis extension points one-to-one so the same plugin
 * objects run on either engine:
 *   preTool        <-> dsh `tools/pre-execute` waterfall (allow | deny)
 *   postTool       <-> dsh `tools/post-execute` waterfall (accept with replaced content)
 *   beforeModel    <-> checked inside the dsh LlmAdapter.stream() before each provider call
 *   afterModel     <-> after each provider call (usage/cost accounting, model_call events)
 *   onStep         <-> dsh `session/event` step/start, step/end
 *   systemRules    <-> appended to the dsh system-prompt personaPrefix
 */
import type { AgentName, StopReason } from '../contract.js'
import type { ModelResponse, ToolCallReq, ToolOutcome } from './types.js'
import type { RunContext } from './run-context.js'

export type PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string }
export type ModelGate = { stop: StopReason | 'budget'; detail: string } | undefined

export interface RgPlugin {
  readonly name: string
  systemRules?(agent: AgentName): string[]
  preTool?(run: RunContext, call: ToolCallReq): PreToolDecision | undefined | Promise<PreToolDecision | undefined>
  postTool?(run: RunContext, call: ToolCallReq, outcome: ToolOutcome): ToolOutcome | Promise<ToolOutcome>
  beforeModel?(run: RunContext): ModelGate
  afterModel?(run: RunContext, res: ModelResponse): void
  onStep?(run: RunContext, phase: 'start' | 'end', info: { step: number; toolCalls?: number }): void
}
