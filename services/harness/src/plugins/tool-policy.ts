/** (c) Tool-policy plugin: per-agent allow-lists + read-only enforcement; denies and logs everything else. */
import { FORBIDDEN_WRITE_TOOL_PATTERNS, TOOL_ALLOW_LIST, type AgentName } from '../contract.js'
import type { PreToolDecision, RgPlugin } from '../core/plugin.js'
import type { RunContext } from '../core/run-context.js'
import type { ToolCallReq } from '../core/types.js'
import type { Logger } from '../logger.js'

export function decideToolPolicy(agent: AgentName, tool: string, allow: Record<AgentName, readonly string[]> = TOOL_ALLOW_LIST): PreToolDecision {
  if (FORBIDDEN_WRITE_TOOL_PATTERNS.some((re) => re.test(tool))) {
    return { kind: 'deny', reason: `policy: "${tool}" is a write tool; agents are read-only (writes go through the approved Action Gateway only)` }
  }
  const list = allow[agent]
  if (!list || !list.includes(tool)) {
    return { kind: 'deny', reason: `policy: tool "${tool}" is not on the ${agent} agent allow-list` }
  }
  return { kind: 'allow' }
}

export class ToolPolicyPlugin implements RgPlugin {
  readonly name = 'tool-policy'
  readonly denials: { run_id: string; agent: AgentName; tool: string; reason: string }[] = []

  constructor(
    private readonly log: Logger,
    private readonly allow: Record<AgentName, readonly string[]> = TOOL_ALLOW_LIST,
  ) {}

  /** Only allowed tools are ever shown to the model (least privilege); preTool still re-checks every call. */
  visibleTools(agent: AgentName): readonly string[] {
    return this.allow[agent] ?? []
  }

  preTool(run: RunContext, call: ToolCallReq): PreToolDecision | undefined {
    const d = decideToolPolicy(run.agent, call.name, this.allow)
    if (d.kind === 'deny') {
      this.denials.push({ run_id: run.runId, agent: run.agent, tool: call.name, reason: d.reason })
      if (this.denials.length > 500) this.denials.shift()
      this.log.warn({ run_id: run.runId, case_id: run.caseId, agent: run.agent, tool: call.name }, 'tool call denied by policy')
      return d
    }
    return undefined // no objection; next plugin decides
  }
}
