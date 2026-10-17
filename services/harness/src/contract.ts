/** Types + allow-lists straight from docs/CONTRACT.md ("Agents" section). */
import { z } from 'zod'

export const AGENTS = ['triage', 'evidence', 'investigation', 'resolution', 'timeline'] as const
export type AgentName = (typeof AGENTS)[number]

export const EVIDENCE_READ_TOOLS = [
  'gmail_search',
  'whatsapp_search',
  'sheets_read_delivery',
  'drive_read_doc',
  'zoho_get_salesorders',
  'zoho_get_invoices',
  'zoho_get_payments',
  'bank_get_payments',
  'read_chat_memory',
] as const

export const TOOL_ALLOW_LIST: Record<AgentName, readonly string[]> = {
  triage: ['laya_decide', 'extract_fields', 'case_attach_or_open'],
  evidence: [...EVIDENCE_READ_TOOLS, 'evidence_add'],
  investigation: [...EVIDENCE_READ_TOOLS, 'search_alt_ids', 'search_credit_notes', 'compute_billable', 'get_billing_rules', 'evidence_add'],
  resolution: ['draft_action', 'risk_score', 'compute_billable'],
  // CONTRACT_V3 §1: reads the case timeline + chat memory; writes only our own chat notes and its decision (never Zoho/WhatsApp/Gmail)
  timeline: ['read_chat_memory', 'search_cases', 'read_case_timeline', 'whatsapp_search', 'sheets_read_delivery', 'write_chat_memory', 'propose_timeline'],
}

/**
 * Tools that write to external business systems. No agent may ever call one (contract: "No agent has any
 * write tool to Zoho/WhatsApp/Gmail. Writes only via API Action Gateway after approval."). The policy plugin
 * denies these even if a misconfigured allow-list contains them.
 */
export const FORBIDDEN_WRITE_TOOL_PATTERNS = [/^zoho_(create|update|delete|void|send)/, /^(whatsapp|wa)_send/, /^gmail_send/, /^gateway_/, /^action_execute/, /_write$/]

export const BudgetSchema = z.object({
  max_steps: z.number().int().positive().max(50),
  max_tokens: z.number().int().positive().max(2_000_000),
  max_seconds: z.number().positive().max(1800),
  max_cost_inr: z.number().nonnegative().max(10_000),
})
export type Budget = z.infer<typeof BudgetSchema>

export const RunRequestSchema = z.object({
  run_id: z.string().min(1),
  case_id: z.string().min(1),
  correlation_id: z.string().min(1),
  agent: z.enum(AGENTS),
  input: z.record(z.unknown()).default({}),
  budget: BudgetSchema.partial().optional(),
})
export type RunRequest = z.infer<typeof RunRequestSchema>

export type AgentEventType = 'step_started' | 'tool_call' | 'tool_result' | 'model_call' | 'step_finished' | 'run_finished' | 'run_failed'

export interface AgentEvent {
  run_id: string
  case_id: string
  type: AgentEventType
  agent: AgentName
  data: Record<string, unknown>
  ts: string
  /** extras (not in the contract's minimal item; safe for the API to ignore) */
  correlation_id: string
  seq: number
}

export type StopReason = 'gap_closed' | 'no_new_evidence' | 'conflict' | 'budget'
export type FailReason = 'invalid_output' | 'budget' | 'llm_unavailable' | 'cancelled' | 'error'
