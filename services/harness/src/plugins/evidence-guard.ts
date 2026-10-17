/**
 * Investigation stop rule enforced in code (design doc: "stop or escalate when evidence is insufficient").
 * After 2 consecutive tool steps that added no new evidence node, the harness tells the model to finalize
 * with stop_reason "no_new_evidence" and denies any further tool call.
 */
import type { PreToolDecision, RgPlugin } from '../core/plugin.js'
import type { RunContext } from '../core/run-context.js'
import type { ToolCallReq, ToolOutcome } from '../core/types.js'

export const STOP_RULE_NOTICE =
  '[harness stop rule] Two consecutive checks added no new evidence. Do not call more tools. ' +
  'Return your final JSON now with stop_reason "no_new_evidence" (or "gap_closed"/"conflict" if that is already true).'

export class EvidenceGuardPlugin implements RgPlugin {
  readonly name = 'evidence-guard'
  constructor(private readonly maxNoEvidence = 2) {}

  preTool(run: RunContext, _call: ToolCallReq): PreToolDecision | undefined {
    if (run.agent === 'investigation' && run.stopRuleFired) {
      return { kind: 'deny', reason: 'stop rule: 2 checks without new evidence; finalize now' }
    }
    return undefined
  }

  postTool(run: RunContext, _call: ToolCallReq, outcome: ToolOutcome): ToolOutcome {
    if (run.agent !== 'investigation' || outcome.denied) return outcome
    const fresh = outcome.evidence_node_ids.filter((id) => !run.seenEvidenceIds.has(id))
    run.consecutiveNoEvidence = fresh.length > 0 ? 0 : run.consecutiveNoEvidence + 1
    if (run.consecutiveNoEvidence >= this.maxNoEvidence && !run.stopRuleFired) {
      run.stopRuleFired = true
      return { ...outcome, text: `${outcome.text}\n\n${STOP_RULE_NOTICE}` }
    }
    return outcome
  }
}
