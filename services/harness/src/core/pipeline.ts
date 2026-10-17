/**
 * The plugin pipeline both engines drive. Order of plugins = order of the waterfall (like Cordis listeners).
 * Tool flow:  tool_call event -> preTool chain (first deny wins) -> execute (HTTP) -> postTool chain -> record -> tool_result event
 */
import type { AgentName } from '../contract.js'
import type { ModelGate, PreToolDecision, RgPlugin } from './plugin.js'
import type { RunContext } from './run-context.js'
import type { ModelResponse, ToolCallReq, ToolOutcome, ToolSchemaJson, ToolSpec } from './types.js'
import { toJsonSchema, type ToolExecutor } from '../plugins/rg-tools.js'

export class Pipeline {
  constructor(
    readonly plugins: RgPlugin[],
    readonly toolSpecs: Map<string, ToolSpec>,
    readonly executor: ToolExecutor,
    readonly visibleTools: (agent: AgentName) => readonly string[],
  ) {}

  systemRules(agent: AgentName): string[] {
    return this.plugins.flatMap((p) => p.systemRules?.(agent) ?? [])
  }

  toolsFor(agent: AgentName): ToolSpec[] {
    return this.visibleTools(agent).map((n) => this.toolSpecs.get(n)).filter((t): t is ToolSpec => !!t)
  }

  toolSchemasFor(agent: AgentName): ToolSchemaJson[] {
    return this.toolsFor(agent).map(toJsonSchema)
  }

  gateModel(run: RunContext): ModelGate {
    for (const p of this.plugins) {
      const g = p.beforeModel?.(run)
      if (g) return g
    }
    return undefined
  }

  afterModel(run: RunContext, res: ModelResponse): void {
    for (const p of this.plugins) p.afterModel?.(run, res)
  }

  step(run: RunContext, phase: 'start' | 'end', toolCalls?: number): void {
    if (phase === 'start') run.step += 1
    for (const p of this.plugins) p.onStep?.(run, phase, { step: run.step, toolCalls })
  }

  async pre(run: RunContext, call: ToolCallReq): Promise<PreToolDecision> {
    run.emit('tool_call', { step: run.step, call_id: call.id, tool: call.name, args: call.args })
    for (const p of this.plugins) {
      const d = await p.preTool?.(run, call)
      if (d?.kind === 'deny') return d
    }
    return { kind: 'allow' }
  }

  async execute(run: RunContext, call: ToolCallReq, signal?: AbortSignal): Promise<ToolOutcome> {
    return this.executor.execute(run, call, signal)
  }

  deniedOutcome(reason: string): ToolOutcome {
    return { ok: false, denied: true, data: null, evidence_node_ids: [], error: reason, text: JSON.stringify({ ok: false, denied: true, error: reason }) }
  }

  async post(run: RunContext, call: ToolCallReq, outcome: ToolOutcome): Promise<ToolOutcome> {
    let o = outcome
    for (const p of this.plugins) if (p.postTool) o = await p.postTool(run, call, o)
    run.record(call, o)
    run.emit('tool_result', {
      step: run.step,
      call_id: call.id,
      tool: call.name,
      ok: o.ok,
      ...(o.denied ? { denied: true, reason: o.error } : {}),
      ...(o.error && !o.denied ? { error: o.error } : {}),
      evidence_node_ids: o.evidence_node_ids,
      ...(o.untrusted_flag ? { untrusted_flag: true } : {}),
      latency_ms: o.latency_ms,
    })
    return o
  }

  /** Full flow for engines that own the loop (builtin). */
  async handleToolCall(run: RunContext, call: ToolCallReq): Promise<ToolOutcome> {
    const d = await this.pre(run, call)
    const raw = d.kind === 'deny' ? this.deniedOutcome(d.reason) : await this.execute(run, call)
    return this.post(run, call, raw)
  }
}
