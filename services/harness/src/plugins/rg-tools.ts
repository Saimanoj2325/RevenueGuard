/**
 * (b) RevenueGuard tool plugin: the contract's tools, each an HTTP call to
 *   POST {API_URL}/tools/<name>   body {case_id, correlation_id, args}   -> {ok, data, evidence_node_ids?}
 * signed with X-RG-Signature/X-RG-Timestamp and tagged with X-RG-Agent (the API re-checks the allow-list).
 * Argument shapes below are the harness's proposal; the API owns final semantics (extra args pass through).
 */
import { signedHeaders } from '../hmac.js'
import type { RunContext } from '../core/run-context.js'
import type { ToolCallReq, ToolOutcome, ToolParam, ToolSchemaJson, ToolSpec } from '../core/types.js'

const s = (description: string, required = false): ToolParam => ({ type: 'string', description, required })
const n = (description: string, required = false): ToolParam => ({ type: 'number', description, required })
const o = (description: string, required = false): ToolParam => ({ type: 'object', description, required })
const a = (description: string, required = false): ToolParam => ({ type: 'array', description, required })

const refArgs = {
  ref: s('Order/PO/invoice reference to search for, e.g. "PO-184"'),
  customer: s('Customer name or Zoho customer id'),
}

export const TOOL_SPECS: ToolSpec[] = [
  // triage
  { name: 'laya_decide', external: false, description: 'Ask the Laya decision service standard questions (severity, exception_type, genuine, needs_review, injection) about a case state. Returns answers with probabilities.', params: { state: s('Case state or message text to classify', true), questions: a('Optional question set [{id,type,text,options?}]; omit for the standard set') } },
  { name: 'extract_fields', external: true, description: 'Extract normalized fields (customer, order reference, qty, amount, dates, invoice id, payment ref) from a source record or text.', params: { text: s('Raw text to extract from'), source_id: s('Evidence/source id to extract from') } },
  { name: 'case_attach_or_open', external: false, description: 'Attach the incoming record to an existing case with matching references, or open a new case. Returns the case id.', params: { refs: o('{po, customer, amount, qty}', true), source_id: s('Triggering source record id') } },
  // evidence reads
  { name: 'gmail_search', external: true, description: 'Search authorized Gmail messages (read-only).', params: { query: s('Gmail search query, e.g. "PO-184 OR PO184"', true), max_results: n('Max messages (default 10)') } },
  { name: 'whatsapp_search', external: true, description: 'Search stored WhatsApp messages, including transcribed voice notes and parsed images (read-only).', params: { q: s('Search text, e.g. "PO-184"'), text: s('Same as q (timeline agent name)'), chat: s('Chat id filter'), chat_key: s('Same as chat'), since: s('ISO date or unix seconds') } },
  { name: 'sheets_read_delivery', external: true, description: 'Read delivery/dispatch rows for a reference from the configured operations sheet (read-only).', params: { ...refArgs, po_ref: s('Same as ref') } },
  { name: 'drive_read_doc', external: true, description: 'Read a Drive document (PO PDF, challan) by id or search query (read-only).', params: { doc_id: s('Drive file id'), query: s('Search query') } },
  { name: 'zoho_get_salesorders', external: true, description: 'Read Zoho Books sales orders by reference or customer (read-only).', params: { ...refArgs } },
  { name: 'zoho_get_invoices', external: true, description: 'Read Zoho Books invoices by reference or customer (read-only).', params: { ...refArgs, status: s('Invoice status filter') } },
  { name: 'zoho_get_payments', external: true, description: 'Read Zoho Books customer payments (read-only).', params: { ...refArgs } },
  { name: 'bank_get_payments', external: true, description: 'Read uploaded bank statement credits matching a reference/amount (read-only).', params: { ...refArgs, amount: n('Amount in INR') } },
  { name: 'read_chat_memory', external: false, description: 'Read what each WhatsApp chat tied to this case has told us so far: POs it talks about, challans received, and its recent statements as read by the LLM (corrections, extra deliveries). Use it before deciding how to read a delivery conflict.', params: { chat: s('Optional chat id filter'), chat_key: s('Same as chat; any chat of this business') } },
  { name: 'evidence_add', external: false, description: 'Record a finding (including a negative finding such as "no invoice found") as an evidence node on the case. Returns its evidence_node_id.', params: { kind: s('order|delivery|invoice|payment|message|finding', true), source: s('gmail|whatsapp|sheets|drive|zoho|bank|media|harness', true), source_id: s('Source record id'), title: s('Short title', true), excerpt: s('Supporting excerpt'), fields: o('Normalized fields') } },
  // investigation
  { name: 'search_alt_ids', external: false, description: 'Search accounting records for alternate spellings/variants of a reference (PO-184, PO184, PO 184, customer refs) to find invoices stored under another ID.', params: { ref: s('Reference to expand into variants', true), customer: s('Customer filter') } },
  { name: 'search_credit_notes', external: false, description: 'Search Zoho credit notes that could offset or explain the gap.', params: { ...refArgs } },
  { name: 'compute_billable', external: false, description: 'Deterministic billable amount (Python Decimal) from order qty, delivered qty, rate and the billing rule.', params: { order_qty: n('Ordered quantity', true), delivered_qty: n('Delivered quantity', true), rate: n('Unit rate in INR', true), rule: s('Billing rule id, e.g. "partial_delivery_allowed"') } },
  { name: 'get_billing_rules', external: false, description: 'Read the configured billing rules for a customer (e.g. whether partial-delivery invoicing is allowed).', params: { customer: s('Customer name or id') } },
  // resolution
  // timeline (CONTRACT_V3 §1)
  { name: 'read_case_timeline', external: true, description: 'Every message of a case in time order with status (active|edited|deleted|duplicate|superseded), old versions, read_by, challan number and qty as read.', params: { case_ref: s('Case number or id; omit for this case'), why: s('Why you call this now') } },
  { name: 'search_cases', external: false, description: "Find this business's cases by PO number, customer or free text.", params: { query: s('Free text'), po_ref: s('PO number, e.g. "PO-184"'), customer: s('Customer name'), why: s('Why you call this now') } },
  { name: 'write_chat_memory', external: false, description: "Update the chat's memory: active_po, open_questions, pending, summary (<= 600 chars). Our own notes only; never sends anything.", params: { chat_key: s('Chat id', true), patch: o('{active_po?, open_questions?, pending?, summary?}', true), why: s('Why you call this now') } },
  { name: 'propose_timeline', external: false, description: 'Run the code checks on a TimelineDecision (ids, grounding, sum, link, confidence) and get the failed checks back before you answer.', params: { case_ref: s('Case number or id'), decision: o('Your TimelineDecision JSON', true), why: s('Why you call this now') } },
  { name: 'draft_action', external: false, description: 'Draft (NOT execute) a proposed action payload for human approval; validates shape against the Action Gateway.', params: { action: o('Proposed action {type, customer_id, reference, line_items, amount, message?, channel?}', true) } },
  { name: 'risk_score', external: false, description: 'Deterministic risk score for a proposed action (amount, conflicts, evidence coverage).', params: { action: o('Proposed action', true), evidence_node_ids: a('Supporting evidence ids') } },
]

export const TOOL_SPEC_MAP = new Map(TOOL_SPECS.map((t) => [t.name, t]))

export function toJsonSchema(spec: ToolSpec): ToolSchemaJson {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [k, p] of Object.entries(spec.params)) {
    properties[k] =
      p.type === 'object'
        ? { type: 'object', description: p.description, additionalProperties: true }
        : p.type === 'array'
          ? { type: 'array', description: p.description, items: {} }
          : { type: p.type, description: p.description, ...(p.enum ? { enum: p.enum } : {}) }
    if (p.required) required.push(k)
  }
  return { type: 'function', function: { name: spec.name, description: spec.description, parameters: { type: 'object', properties, required, additionalProperties: true } } }
}

export interface ToolExecutorOptions {
  apiUrl: string
  secret: string
  timeoutMs: number
  maxResultChars: number
  fetchImpl?: typeof fetch
}

export class ToolExecutor {
  constructor(private readonly opts: ToolExecutorOptions) {}

  async execute(run: RunContext, call: ToolCallReq, signal?: AbortSignal): Promise<ToolOutcome> {
    const started = Date.now()
    const body = JSON.stringify({ case_id: run.caseId, correlation_id: run.correlationId, args: call.args })
    const f = this.opts.fetchImpl ?? fetch
    try {
      const res = await f(`${this.opts.apiUrl}/tools/${encodeURIComponent(call.name)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-RG-Agent': run.agent,
          'X-RG-Run-Id': run.runId,
          'X-Correlation-Id': run.correlationId,
          ...signedHeaders(body, this.opts.secret),
        },
        body,
        signal: AbortSignal.any([AbortSignal.timeout(this.opts.timeoutMs), ...(signal ? [signal] : []), run.signal]),
      })
      const latency_ms = Date.now() - started
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: unknown; evidence_node_ids?: unknown; error?: string; detail?: unknown }
      const ids = Array.isArray(json.evidence_node_ids) ? json.evidence_node_ids.filter((x): x is string => typeof x === 'string') : []
      if (!res.ok || json.ok === false) {
        const error = json.error ?? (typeof json.detail === 'string' ? json.detail : `http_${res.status}`)
        const denied = res.status === 403
        return { ok: false, data: json.data ?? null, evidence_node_ids: ids, text: this.clip(JSON.stringify({ ok: false, error, ...(denied ? { denied_by: 'api_policy' } : {}) })), error, denied, latency_ms }
      }
      return { ok: true, data: json.data ?? null, evidence_node_ids: ids, text: this.clip(JSON.stringify({ ok: true, data: json.data ?? null, evidence_node_ids: ids })), latency_ms }
    } catch (err) {
      const error = (err as Error).name === 'TimeoutError' ? 'tool_timeout' : (err as Error).message
      return { ok: false, data: null, evidence_node_ids: [], text: JSON.stringify({ ok: false, error }), error, latency_ms: Date.now() - started }
    }
  }

  private clip(t: string): string {
    return t.length > this.opts.maxResultChars ? `${t.slice(0, this.opts.maxResultChars)}…[truncated ${t.length - this.opts.maxResultChars} chars]` : t
  }
}
