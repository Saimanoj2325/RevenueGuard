/**
 * (e) Output-schema plugin: zod schemas from the contract validate the final output; ≤2 repair retries,
 * else run_failed with reason "invalid_output". On top of the schema it runs grounding checks:
 *   - investigation: every step.tool must be a tool actually called in this run; step evidence ids must exist
 *   - resolution / investigation / evidence: cited evidence ids must exist (case snapshot or tool results)
 */
import type { ZodError } from 'zod'
import type { AgentName } from '../contract.js'
import type { RunContext } from '../core/run-context.js'
import { OUTPUT_SCHEMAS, OUTPUT_SHAPES } from '../schemas.js'
import { extractFirstJson } from './mock-llm.js'

export type ValidationResult = { ok: true; output: unknown } | { ok: false; errors: string[]; raw: string }

export function parseModelJson(text: string | null | undefined): unknown {
  if (!text) return undefined
  const t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fence ? fence[1]!.trim() : t
  try {
    return JSON.parse(candidate)
  } catch {
    return extractFirstJson(candidate)
  }
}

function zodErrors(e: ZodError): string[] {
  return e.issues.slice(0, 12).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
}

export function groundingErrors(agent: AgentName, output: Record<string, unknown>, ctx: { calledTools: Set<string>; seenIds: Set<string> }): string[] {
  const errs: string[] = []
  const checkIds = (ids: unknown, where: string) => {
    if (ctx.seenIds.size === 0 || !Array.isArray(ids)) return
    for (const id of ids) if (typeof id === 'string' && !ctx.seenIds.has(id)) errs.push(`${where}: evidence id "${id}" does not exist in the case or tool results`)
  }
  if (agent === 'investigation') {
    const steps = (output.steps as { tool: string; evidence_node_ids: string[] }[]) ?? []
    steps.forEach((s, i) => {
      if (!ctx.calledTools.has(s.tool)) errs.push(`steps.${i}.tool: "${s.tool}" was not called in this run`)
      checkIds(s.evidence_node_ids, `steps.${i}.evidence_node_ids`)
    })
  }
  if (agent === 'resolution') {
    const claims = (output.claims as { evidence_node_ids: string[] }[]) ?? []
    claims.forEach((c, i) => checkIds(c.evidence_node_ids, `claims.${i}.evidence_node_ids`))
  }
  if (agent === 'evidence') checkIds(output.nodes_added, 'nodes_added')
  return errs
}

export function validateOutput(agent: AgentName, text: string | null | undefined, ctx?: { calledTools: Set<string>; seenIds: Set<string> }): ValidationResult {
  const raw = text ?? ''
  const parsed = parseModelJson(raw)
  if (parsed === undefined) return { ok: false, errors: ['output is not a JSON object'], raw }
  const r = OUTPUT_SCHEMAS[agent].safeParse(parsed)
  if (!r.success) return { ok: false, errors: zodErrors(r.error), raw }
  if (ctx) {
    const g = groundingErrors(agent, r.data as Record<string, unknown>, ctx)
    if (g.length) return { ok: false, errors: g, raw }
  }
  return { ok: true, output: r.data }
}

export function repairPrompt(agent: AgentName, errors: string[], attempt: number, max: number): string {
  return [
    `Your final output failed validation (repair attempt ${attempt}/${max}). Errors:`,
    ...errors.map((e) => `- ${e}`),
    '',
    'Do not call tools. Reply with ONLY the corrected JSON object, no prose, no code fences, matching exactly:',
    OUTPUT_SHAPES[agent],
  ].join('\n')
}

export class OutputSchemaPlugin {
  readonly name = 'output-schema'
  constructor(readonly maxRepairs = 2) {}

  validate(run: RunContext, text: string | null | undefined): ValidationResult {
    return validateOutput(run.agent, text, { calledTools: new Set(run.toolLog.filter((t) => !t.denied).map((t) => t.tool)), seenIds: run.seenEvidenceIds })
  }
}
