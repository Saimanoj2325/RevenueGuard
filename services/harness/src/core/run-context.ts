import type { AgentEventType, AgentName, Budget, StopReason } from '../contract.js'
import type { ToolCallReq, ToolOutcome } from './types.js'

export interface RecordedStep {
  call_id: string
  tool: string
  args: Record<string, unknown>
  ok: boolean
  denied: boolean
  evidence_node_ids: string[]
}

export type EmitFn = (type: AgentEventType, data: Record<string, unknown>) => void

/** Per-run mutable state shared by plugins and engines. */
export class RunContext {
  readonly startedAt = Date.now()
  step = 0
  tokensIn = 0
  tokensOut = 0
  costInr = 0
  modelCalls = 0
  /** set by budget / guard plugins; the engine stops the loop when present */
  stop: { reason: StopReason | 'budget'; detail: string } | undefined
  readonly toolLog: RecordedStep[] = []
  readonly seenEvidenceIds = new Set<string>()
  readonly providersUsed = new Set<string>()
  consecutiveNoEvidence = 0
  /** true while the output-schema plugin is running repair turns */
  repairing = false
  /** set once the investigation stop rule (2 checks without new evidence) fired */
  stopRuleFired = false
  private readonly abort = new AbortController()

  constructor(
    readonly runId: string,
    readonly caseId: string,
    readonly correlationId: string,
    readonly agent: AgentName,
    readonly input: Record<string, unknown>,
    readonly budget: Budget,
    readonly emit: EmitFn,
  ) {
    collectInputEvidenceIds(input, this.seenEvidenceIds)
  }

  get signal(): AbortSignal {
    return this.abort.signal
  }
  get elapsedMs(): number {
    return Date.now() - this.startedAt
  }
  get totalTokens(): number {
    return this.tokensIn + this.tokensOut
  }

  requestStop(reason: StopReason | 'budget', detail: string): void {
    if (!this.stop) this.stop = { reason, detail }
  }

  cancel(reason: string): void {
    if (!this.abort.signal.aborted) this.abort.abort(new Error(reason))
  }

  record(call: ToolCallReq, outcome: ToolOutcome): void {
    this.toolLog.push({
      call_id: call.id,
      tool: call.name,
      args: call.args,
      ok: outcome.ok,
      denied: !!outcome.denied,
      evidence_node_ids: outcome.evidence_node_ids,
    })
    for (const id of outcome.evidence_node_ids) this.seenEvidenceIds.add(id)
  }

  usage() {
    return {
      steps: this.step,
      model_calls: this.modelCalls,
      input_tokens: this.tokensIn,
      output_tokens: this.tokensOut,
      cost_inr: Math.round(this.costInr * 10000) / 10000,
      elapsed_ms: this.elapsedMs,
      providers: [...this.providersUsed],
    }
  }
}

/** Evidence ids already in the case snapshot: evidence[].id (API snapshot), evidence.nodes[].id and any *evidence_node_ids / nodes_added arrays. */
export function collectInputEvidenceIds(value: unknown, out: Set<string>, parentKey = '', depth = 0): void {
  if (depth > 8 || value == null) return
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string' && /(evidence_node_ids|nodes_added)$/.test(parentKey)) out.add(v)
      else if (v && typeof v === 'object' && (parentKey === 'nodes' || parentKey === 'evidence') && typeof (v as { id?: unknown }).id === 'string') {
        out.add((v as { id: string }).id)
        collectInputEvidenceIds(v, out, '', depth + 1)
      } else collectInputEvidenceIds(v, out, parentKey, depth + 1)
    }
    return
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) collectInputEvidenceIds(v, out, k, depth + 1)
  }
}
