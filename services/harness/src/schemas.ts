/** Output schemas from docs/CONTRACT.md ("Output schemas"), as zod. */
import { z } from 'zod'
import type { AgentName } from './contract.js'

const prob = z.number().min(0).max(1)

export const TriageOutput = z.object({
  exception_type: z.enum(['missing_invoice', 'partial_delivery', 'duplicate_invoice', 'partial_payment', 'quantity_conflict', 'billing_not_due', 'none']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  genuine_prob: prob,
  needs_review_prob: prob,
  laya: z.record(z.unknown()),
  refs: z.object({
    po: z.string().nullable(),
    customer: z.string().nullable(),
    amount: z.number().nullable(),
    qty: z.number().nullable(),
  }),
  summary: z.string().min(1),
})

export const EvidenceOutput = z.object({
  nodes_added: z.array(z.string()),
  missing_links: z.array(z.enum(['order', 'delivery', 'invoice', 'payment'])),
  summary: z.string().min(1),
})

export const InvestigationOutput = z.object({
  steps: z.array(
    z.object({
      tool: z.string().min(1),
      why: z.string().min(1),
      added_evidence: z.boolean(),
      evidence_node_ids: z.array(z.string()),
    }),
  ),
  findings: z.array(z.string()),
  stop_reason: z.enum(['gap_closed', 'no_new_evidence', 'conflict', 'budget']),
  conflict: z.boolean(),
})

export const ResolutionOutput = z.object({
  action: z.object({
    type: z.enum(['create_invoice', 'send_reminder', 'none']),
    customer_id: z.string().nullable(),
    customer_name: z.string().nullable(),
    reference: z.string().nullable(),
    line_items: z.array(z.object({ item: z.string().min(1), qty: z.number().nonnegative(), rate: z.number().nonnegative() })),
    amount: z.number().nonnegative(),
    message: z.string().optional(),
    channel: z.enum(['whatsapp', 'gmail']).optional(),
  }),
  // "every claim cites evidence_node_ids"
  claims: z.array(z.object({ text: z.string().min(1), evidence_node_ids: z.array(z.string()).min(1) })),
  uncertainty: z.array(z.string()),
  risk: z.enum(['low', 'medium', 'high']),
})

// CONTRACT_V3 §1 TimelineDecision (strict: no extra keys)
export const TimelineDecision = z
  .object({
    link: z
      .object({
        action: z.enum(['existing_case', 'new_case', 'ask_which_po', 'not_business']),
        case_ref: z.string().nullable(),
        po_ref: z.string().nullable(),
        why: z.string().min(1),
      })
      .strict(),
    meaning: z.enum(['delivery', 'extra_delivery', 'correction', 'duplicate', 'edit', 'retraction', 'payment', 'order', 'question', 'noise']),
    delivered: z
      .object({
        total: z.number().nullable(),
        events: z.array(
          z
            .object({
              node_id: z.string().min(1),
              qty: z.number(),
              role: z.string().regex(/^(counts|replaced|ignored|duplicate_of:.+)$/),
              why: z.string().min(1),
            })
            .strict(),
        ),
      })
      .strict(),
    memory_patch: z.record(z.unknown()),
    confidence: prob,
    explanation_for_owner: z.string().min(1).max(400),
  })
  .strict()

export const OUTPUT_SCHEMAS = {
  triage: TriageOutput,
  evidence: EvidenceOutput,
  investigation: InvestigationOutput,
  resolution: ResolutionOutput,
  timeline: TimelineDecision,
} satisfies Record<AgentName, z.ZodTypeAny>

export type TriageOutputT = z.infer<typeof TriageOutput>
export type EvidenceOutputT = z.infer<typeof EvidenceOutput>
export type InvestigationOutputT = z.infer<typeof InvestigationOutput>
export type ResolutionOutputT = z.infer<typeof ResolutionOutput>
export type TimelineDecisionT = z.infer<typeof TimelineDecision>

/** Human-readable JSON shape shown to the model in its system prompt. */
export const OUTPUT_SHAPES: Record<AgentName, string> = {
  triage: `{"exception_type":"missing_invoice|partial_delivery|duplicate_invoice|partial_payment|quantity_conflict|billing_not_due|none","severity":"low|medium|high|critical","genuine_prob":0.0-1.0,"needs_review_prob":0.0-1.0,"laya":{...raw laya_decide result...},"refs":{"po":string|null,"customer":string|null,"amount":number|null,"qty":number|null},"summary":string}`,
  evidence: `{"nodes_added":[evidence node ids],"missing_links":["order"|"delivery"|"invoice"|"payment"],"summary":string}`,
  investigation: `{"steps":[{"tool":string,"why":string,"added_evidence":boolean,"evidence_node_ids":[string]}],"findings":[string],"stop_reason":"gap_closed|no_new_evidence|conflict|budget","conflict":boolean}`,
  resolution: `{"action":{"type":"create_invoice|send_reminder|none","customer_id":string|null,"customer_name":string|null,"reference":string|null,"line_items":[{"item":string,"qty":number,"rate":number}],"amount":number,"message"?:string,"channel"?:"whatsapp|gmail"},"claims":[{"text":string,"evidence_node_ids":[at least one id]}],"uncertainty":[string],"risk":"low|medium|high"}`,
  timeline: `{"link":{"action":"existing_case|new_case|ask_which_po|not_business","case_ref":string|null,"po_ref":string|null,"why":string},"meaning":"delivery|extra_delivery|correction|duplicate|edit|retraction|payment|order|question|noise","delivered":{"total":number|null,"events":[{"node_id":string,"qty":number,"role":"counts|replaced|ignored|duplicate_of:<node_id>","why":string}]},"memory_patch":{"active_po"?:string|null,"open_questions"?:[string],"pending"?:[string],"summary"?:string},"confidence":0.0-1.0,"explanation_for_owner":string}`,
}
