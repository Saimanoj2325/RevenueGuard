/**
 * MOCK_LLM=true: a deterministic "provider" behind the model router. It reads exactly what a real model would see
 * (the case snapshot in the first user message + tool results), calls the real tool pipeline (policy, untrusted
 * wrapping, events, budget all apply) and emits schema-valid final JSON. Nothing is scripted per PO: the PO
 * reference, customer, item, ordered qty, rate, delivered qty and billable amount are DERIVED from the snapshot
 * (case / facts / evidence fields) and tool results (compute_billable, sheets_read_delivery, draft_action …), so any
 * order works — PO-184 (₹60,000 → ₹70,000 after the WhatsApp correction), PO-185 (₹2,00,000) or a live case.
 *  - triage:        laya_decide -> case_attach_or_open
 *  - evidence:      gmail_search -> whatsapp_search -> sheets_read_delivery -> zoho_get_invoices
 *  - investigation: search_alt_ids -> search_credit_notes -> sheets_read_delivery -> get_billing_rules -> gap_closed
 *  - resolution:    compute_billable -> risk_score -> draft_action -> action from the validator-backed draft
 * Extra knobs: input._mock.garbage_outputs (or MOCK_LLM_GARBAGE) = N invalid final outputs first, to
 * exercise the output-schema repair loop (demo chaos "garbage_output").
 */
import type { AgentName } from '../contract.js'
import type { ChatMessage, ChatToolCall, ModelRequest, ModelUsage } from '../core/types.js'
import { estimateTokens, type ModelProvider, type ProviderCallResult } from './model-router.js'
import { STOP_RULE_NOTICE } from './evidence-guard.js'

const PLANS: Record<AgentName, string[]> = {
  triage: ['laya_decide', 'case_attach_or_open'],
  evidence: ['gmail_search', 'whatsapp_search', 'sheets_read_delivery', 'zoho_get_invoices'],
  investigation: ['search_alt_ids', 'search_credit_notes', 'sheets_read_delivery', 'get_billing_rules'],
  resolution: ['compute_billable', 'risk_score', 'draft_action'],
  timeline: ['read_case_timeline', 'read_chat_memory'],
}

const WHY: Record<string, (ref: string) => string> = {
  search_alt_ids: (ref) => `Gap is a missing invoice; first rule out that an invoice exists under an alternate reference of ${ref} (no separators, spaces, customer ref) before proposing a new one.`,
  search_credit_notes: () => 'No invoice under alternate IDs; check whether a credit note offsets or explains this order before treating it as unbilled.',
  sheets_read_delivery: () => 'Invoice genuinely absent; the billable amount depends on delivered quantity, so confirm delivery from the operations sheet.',
  get_billing_rules: () => 'Billable amount depends on the billing rule (bill on delivery / partial deliveries allowed?), so read it before proposing.',
}

interface ToolTurn {
  name: string
  args: Record<string, unknown>
  resultText: string
  result: { ok?: boolean; data?: unknown; evidence_node_ids?: string[] } | undefined
}

export class MockLlmProvider implements ModelProvider {
  readonly name = 'mock'
  readonly model = 'mock-deterministic-v2'
  private garbageServed = new Map<string, number>()

  constructor(private readonly envGarbage = Number(process.env.MOCK_LLM_GARBAGE ?? 0)) {}

  costInr(_u: ModelUsage): number {
    return 0
  }

  async call(req: ModelRequest, _signal: AbortSignal): Promise<ProviderCallResult> {
    const input = parseSnapshot(req.messages)
    const turns = toolTurns(req.messages)
    const allText = JSON.stringify(input) + '\n' + turns.map((t) => t.resultText).join('\n')
    const usage = { input_tokens: estimateTokens(req.messages), output_tokens: 0 }

    const stopRule = turns.some((t) => t.resultText.includes(STOP_RULE_NOTICE))
    const called = turns.map((t) => t.name)
    const plan = PLANS[req.agent]
    const next = stopRule ? undefined : plan.find((tool) => !called.includes(tool))
    const allowed = new Set(req.tools.map((t) => t.function.name))

    if (next && allowed.has(next)) {
      const call: ChatToolCall = { id: `mock_${req.agent}_${called.length + 1}`, type: 'function', function: { name: next, arguments: JSON.stringify(argsFor(next, input, turns, allText)) } }
      usage.output_tokens = 30
      return { content: null, tool_calls: [call], usage }
    }

    // final answer (possibly garbage first, to exercise repair)
    const runKey = `${req.agent}:${String((input as { run_id?: string }).run_id ?? '')}:${firstUserHash(req.messages)}`
    const wantGarbage = Number((input as { _mock?: { garbage_outputs?: number } })._mock?.garbage_outputs ?? this.envGarbage) || 0
    const served = this.garbageServed.get(runKey) ?? 0
    if (served < wantGarbage) {
      this.garbageServed.set(runKey, served + 1)
      usage.output_tokens = 20
      return { content: served === 0 ? 'Sure! The invoice looks missing. {"exception_type": "maybe", severity: high' : '{"oops": true}', tool_calls: [], usage }
    }
    const out = finalFor(req.agent, input, turns, allText, stopRule)
    const content = JSON.stringify(out)
    usage.output_tokens = Math.ceil(content.length / 4)
    return { content, tool_calls: [], usage }
  }
}

// ---------- helpers ----------

export function extractFirstJson(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

function parseSnapshot(messages: ChatMessage[]): Record<string, unknown> {
  const first = messages.find((m) => m.role === 'user')
  if (!first || typeof first.content !== 'string') return {}
  const fence = first.content.match(/```json\s*([\s\S]*?)```/)
  try {
    return (fence ? JSON.parse(fence[1]!) : extractFirstJson(first.content)) as Record<string, unknown>
  } catch {
    return {}
  }
}

function firstUserHash(messages: ChatMessage[]): number {
  const first = messages.find((m) => m.role === 'user')
  const s = typeof first?.content === 'string' ? first.content : ''
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

function toolTurns(messages: ChatMessage[]): ToolTurn[] {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>()
  const out: ToolTurn[] = []
  for (const m of messages) {
    if (m.role === 'assistant') for (const tc of m.tool_calls ?? []) calls.set(tc.id, { name: tc.function.name, args: safeJson(tc.function.arguments) })
    if (m.role === 'tool') {
      const c = calls.get(m.tool_call_id)
      if (!c) continue
      const body = m.content.replace(/^[\s\S]*?<untrusted_content[^>]*>\s*/, '')
      out.push({ ...c, resultText: m.content, result: extractFirstJson(body) as ToolTurn['result'] })
    }
  }
  return out
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return {}
  }
}


// ---------- derivation of case facts (snapshot first, then tool results, then text) ----------

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/[₹,\s]/g, ''))
    return Number.isNaN(n) ? undefined : n
  }
  return undefined
}

function deepFind(obj: unknown, keys: string[], depth = 0): unknown {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) if (keys.includes(k) && v != null) return v
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const r = deepFind(v, keys, depth + 1)
    if (r !== undefined) return r
  }
  return undefined
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`

/** "Correction: 70 delivered" style messages → the corrected delivered quantity (latest wins). */
export function correctedQty(text: string): number | undefined {
  let out: number | undefined
  const re = /correction[^\n]{0,80}?\b(\d[\d,]*)\b\s*(?:units?|boxes|pcs|nos)?[^\n]{0,20}?deliver/gi
  for (let m = re.exec(text); m; m = re.exec(text)) out = num(m[1])
  return out
}

export function hasCorrection(text: string): boolean {
  return correctedQty(text) !== undefined
}

function normRef(r: string): string {
  const m = r.match(/^\s*([A-Za-z]{2,4})[\s\-_/#]*0*(\d+)\s*$/)
  return m ? `${m[1]!.toUpperCase()}-${m[2]}` : r.trim()
}

export interface Derived {
  ref: string | null
  customer: string | null
  customerId: string | null
  item: string | null
  orderQty: number | null
  rate: number | null
  orderAmount: number | null
  deliveredQty: number | null
  billable: number | null
  billableQty: number | null
  correction: boolean
}

function evidenceList(input: Record<string, unknown>): Record<string, unknown>[] {
  const ev = input.evidence
  if (Array.isArray(ev)) return ev.map(obj)
  const nodes = obj(ev).nodes
  return Array.isArray(nodes) ? nodes.map(obj) : []
}

function fieldFromEvidence(evidence: Record<string, unknown>[], keys: string[], ref: string | null): unknown {
  for (const e of evidence) {
    const f = obj(e.fields)
    const nref = str(f.po_ref)
    if (ref && nref && normRef(nref) !== normRef(ref)) continue
    for (const k of keys) if (f[k] != null && f[k] !== '') return f[k]
  }
  return undefined
}

export function derive(input: Record<string, unknown>, turns: ToolTurn[], allText: string): Derived {
  const c = obj(input.case)
  const facts = obj(input.facts)
  const triageRefs = obj(obj(input.triage).refs)
  const evidence = evidenceList(input)
  const tool = (name: string) => turns.filter((t) => t.name === name).map((t) => t.result?.data)
  const lastTool = (name: string) => tool(name).at(-1)

  const refText = allText.match(/\b(PO|SO)[\s\-#]*0*(\d{1,7})\b/i)
  const ref =
    str(c.po_ref) ?? str(facts.po_ref) ?? str(triageRefs.po) ?? str(fieldFromEvidence(evidence, ['po_ref'], null)) ??
    str(deepFind(lastTool('case_attach_or_open'), ['po_ref'])) ?? (refText ? `${refText[1]!.toUpperCase()}-${refText[2]}` : undefined) ?? null

  const sheetRows = tool('sheets_read_delivery').flatMap((d) => {
    const rows = obj(d).rows
    return Array.isArray(rows) ? rows.map(obj) : d && typeof d === 'object' ? [obj(d)] : []
  }).filter((r) => !ref || !str(r.po_ref ?? r.ref) || normRef(String(r.po_ref ?? r.ref)) === normRef(ref))
  const lastRow = sheetRows.at(-1) ?? {}

  const cb = obj(lastTool('compute_billable'))
  const cbBill = cb.billable
  const draft = obj(obj(lastTool('draft_action')).action)

  const orderQty =
    num(facts.order_qty) ?? num(fieldFromEvidence(evidence, ['qty_ordered'], ref)) ?? num(cb.order_qty) ?? num(lastRow.qty_ordered ?? lastRow.ordered_qty) ??
    num(deepFind(triageRefs, ['qty'])) ?? num(allText.match(/\b(\d[\d,]*)\s*units\b/i)?.[1]) ?? null
  const rate =
    num(facts.rate) ?? num(fieldFromEvidence(evidence, ['rate'], ref)) ?? num(cb.rate) ?? num(obj(cbBill).rate) ??
    num(allText.match(/₹\s?([\d,]+(?:\.\d+)?)\s*(?:per unit|\/\s*unit|each|per piece)/i)?.[1]) ?? num(allText.match(/@\s*₹\s?([\d,]+(?:\.\d+)?)/)?.[1]) ?? null
  const orderAmount = num(facts.order_amount) ?? num(c.amount) ?? num(fieldFromEvidence(evidence, ['amount'], ref)) ?? num(triageRefs.amount) ??
    (orderQty != null && rate != null ? orderQty * rate : null)

  const corr = correctedQty(allText)
  const deliveredQty =
    num(cb.delivered_qty) ?? num(facts.delivered_qty) ?? corr ?? num(lastRow.qty_delivered ?? lastRow.delivered_qty ?? lastRow.delivered) ??
    num(fieldFromEvidence(evidence, ['qty_delivered'], ref)) ?? null

  const factsBill = obj(facts.billable)
  const billable =
    num(draft.amount) ?? (typeof cbBill === 'number' ? cbBill : num(obj(cbBill).amount)) ?? num(factsBill.amount) ??
    (deliveredQty != null && rate != null ? deliveredQty * rate : null)
  const billableQty =
    num(obj((Array.isArray(draft.line_items) ? draft.line_items[0] : undefined) as unknown).qty) ?? num(obj(cbBill).billable_qty) ?? num(factsBill.billable_qty) ??
    (billable != null && rate ? billable / rate : deliveredQty)

  return {
    ref,
    customer: str(draft.customer_name) ?? str(facts.customer_name) ?? str(c.customer) ?? str(fieldFromEvidence(evidence, ['customer'], ref)) ?? str(triageRefs.customer) ?? str(lastRow.customer) ?? null,
    customerId: str(draft.customer_id) ?? str(facts.customer_id) ?? null,
    item: str(facts.item) ?? str(fieldFromEvidence(evidence, ['item'], ref)) ?? str(lastRow.item) ?? null,
    orderQty, rate, orderAmount, deliveredQty, billable, billableQty,
    correction: corr !== undefined || evidence.some((e) => obj(e.fields).is_correction === true),
  }
}

function stateText(input: Record<string, unknown>, d: Derived): string {
  const ev = evidenceList(input)
    .map((e) => [str(e.title), str(e.excerpt), str(e.content)?.replace(/<\/?untrusted_content[^>]*>/g, '')].filter(Boolean).join(': '))
    .filter(Boolean)
  const head = `Order ${d.ref ?? '(reference unknown)'}${d.orderQty != null ? `, ${d.orderQty} units` : ''}${d.orderAmount != null ? ` (${inr(d.orderAmount)})` : ''}${d.customer ? `, customer ${d.customer}` : ''}.`
  return [head, ...ev].join('\n').slice(0, 700)
}

function argsFor(tool: string, input: Record<string, unknown>, turns: ToolTurn[], allText: string): Record<string, unknown> {
  const d = derive(input, turns, allText)
  const ref = d.ref ?? undefined
  switch (tool) {
    case 'laya_decide':
      return { state: stateText(input, d) }
    case 'case_attach_or_open':
      return { refs: { po: d.ref, customer: d.customer, amount: d.orderAmount, qty: d.orderQty } }
    case 'gmail_search':
      return { query: ref ?? 'purchase order' }
    case 'whatsapp_search':
      return { q: ref ?? '' }
    case 'search_alt_ids':
      return { ref: ref ?? '' }
    case 'sheets_read_delivery':
    case 'zoho_get_invoices':
      return ref ? { ref } : {}
    case 'search_credit_notes':
      return { ...(ref ? { ref } : {}), ...(d.customer ? { customer: d.customer } : {}) }
    case 'get_billing_rules':
      return d.customerId ? { customer: d.customerId } : d.customer ? { customer: d.customer } : {}
    case 'compute_billable':
      // the API recomputes from validator facts (Decimal) and ignores these numbers; they only document intent
      return { order_qty: d.orderQty ?? 0, delivered_qty: d.deliveredQty ?? 0, rate: d.rate ?? 0 }
    case 'risk_score':
    case 'draft_action':
      return { action: draftAction(d) }
    case 'read_case_timeline':
      return { why: 'read every message of this case in time order before deciding what the new one means' }
    case 'read_chat_memory': {
      const chat = str(obj(input.trigger).chat_key)
      return { ...(chat ? { chat_key: chat } : {}), why: 'what this chat talks about (POs, open questions)' }
    }
    default:
      return {}
  }
}

function draftAction(d: Derived) {
  return {
    type: 'create_invoice' as const,
    customer_id: d.customerId,
    customer_name: d.customer,
    reference: d.ref,
    line_items: [{ item: d.item ?? 'Item', qty: d.billableQty ?? 0, rate: d.rate ?? 0 }],
    amount: d.billable ?? 0,
  }
}

interface NodeInfo {
  id: string
  text: string
}

function collectNodes(input: unknown, turns: ToolTurn[]): NodeInfo[] {
  const out: NodeInfo[] = []
  const walk = (v: unknown, d = 0) => {
    if (!v || typeof v !== 'object' || d > 8) return
    if (Array.isArray(v)) return v.forEach((x) => walk(x, d + 1))
    const o = v as Record<string, unknown>
    if (typeof o.id === 'string' && (o.kind || o.source || o.title || o.excerpt)) out.push({ id: o.id, text: JSON.stringify(o).toLowerCase() })
    Object.values(o).forEach((x) => walk(x, d + 1))
  }
  walk(input)
  for (const t of turns) for (const id of t.result?.evidence_node_ids ?? []) out.push({ id, text: `${t.name} ${JSON.stringify(t.result?.data ?? '')}`.toLowerCase() })
  return out
}

function pick(nodes: NodeInfo[], re: RegExp): string[] {
  const hit = [...new Set(nodes.filter((n) => re.test(n.text)).map((n) => n.id))]
  if (hit.length) return hit.slice(0, 3)
  return nodes.length ? [nodes[0]!.id] : []
}

function qtyText(d: Derived): string {
  return d.deliveredQty != null ? `${d.deliveredQty}${d.orderQty != null ? ` of ${d.orderQty}` : ''} units` : 'an unconfirmed quantity'
}

function finalFor(agent: AgentName, input: Record<string, unknown>, turns: ToolTurn[], allText: string, stopRule: boolean): unknown {
  const nodes = collectNodes(input, turns)
  const d = derive(input, turns, allText)
  const ref = d.ref ?? 'this order'
  const injection = /system\s*:\s*(mark|close|approve|ignore)/i.test(allText)
  const order = `${ref}${d.orderQty != null ? ` for ${d.orderQty}${d.item ? ` × ${d.item}` : ' units'}` : ''}${d.orderAmount != null ? ` (${inr(d.orderAmount)})` : ''}`
  switch (agent) {
    case 'triage': {
      const laya = turns.find((t) => t.name === 'laya_decide')?.result?.data
      const answers = obj(obj(laya).answers)
      const g = num(deepFind(laya, ['genuine_prob'])) ?? num(obj(obj(answers.genuine).probs).yes) ?? 0.9
      const r = num(deepFind(laya, ['needs_review_prob'])) ?? num(obj(obj(answers.needs_review).probs).yes) ?? 0.3
      const sev = str(obj(answers.severity).value)
      const severity = sev && ['low', 'medium', 'high', 'critical'].includes(sev) ? sev : d.orderAmount != null && d.orderAmount >= 100000 ? 'high' : 'medium'
      return {
        exception_type: 'missing_invoice',
        severity,
        genuine_prob: Math.min(1, Math.max(0, g)),
        needs_review_prob: Math.min(1, Math.max(0, r)),
        laya: (laya && typeof laya === 'object' ? laya : { fallback: true }) as Record<string, unknown>,
        refs: { po: d.ref, customer: d.customer, amount: d.orderAmount, qty: d.orderQty },
        summary: `Order ${order}${d.customer ? ` from ${d.customer}` : ''} has no matching invoice linked yet; treat as a possible missing invoice until delivery and billing evidence are checked.`,
      }
    }
    case 'evidence': {
      const added = [...new Set(turns.flatMap((t) => t.result?.evidence_node_ids ?? []))]
      const invoices = turns.filter((t) => t.name === 'zoho_get_invoices').map((t) => deepFind(t.result?.data, ['invoices']))
      const invoiceFound = invoices.some((x) => Array.isArray(x) && x.length > 0)
      const delivered = d.deliveredQty != null
      const missing = [...(delivered ? [] : ['delivery']), ...(invoiceFound ? [] : ['invoice']), 'payment']
      return {
        nodes_added: added,
        missing_links: missing,
        summary: `Searched Gmail, WhatsApp, the delivery sheet and Zoho for ${ref}. ${delivered ? `Delivery evidence shows ${qtyText(d)}.` : 'No delivery evidence yet.'} ${invoiceFound ? 'An invoice already exists for this reference.' : `Zoho shows no invoice for ${ref}.`}${injection ? ' One message contains embedded instructions; treated as untrusted data and ignored.' : ''}`,
      }
    }
    case 'investigation': {
      const steps = turns
        .filter((t) => !t.resultText.includes('policy:'))
        .map((t) => ({ tool: t.name, why: WHY[t.name]?.(ref) ?? `Read-only check chosen for the current gap (${t.name}).`, added_evidence: (t.result?.evidence_node_ids ?? []).length > 0, evidence_node_ids: t.result?.evidence_node_ids ?? [] }))
      const alt = turns.find((t) => t.name === 'search_alt_ids')?.result?.data
      const altMatches = deepFind(alt, ['matching', 'matches'])
      const altHit = Array.isArray(altMatches) && altMatches.length > 0
      const findings = [
        altHit ? `An invoice exists for ${ref} under an alternate reference.` : `No invoice exists for ${ref} under alternate references.`,
        `No credit note offsets ${ref}.`,
        `Delivered quantity is ${qtyText(d)}${d.correction ? ' (an explicit correction message supersedes earlier figures)' : ''}.`,
        'Billing rule allows invoicing the delivered quantity.',
      ]
      return { steps, findings: stopRule ? findings.slice(0, Math.max(1, steps.length)) : findings, stop_reason: stopRule ? 'no_new_evidence' : 'gap_closed', conflict: false }
    }
    case 'timeline':
      return timelineDecision(input, turns)
    case 'resolution': {
      const draft = obj(obj(turns.filter((t) => t.name === 'draft_action').at(-1)?.result?.data).action)
      const toolClaims = obj(turns.filter((t) => t.name === 'draft_action').at(-1)?.result?.data).claims
      const toolUnc = obj(turns.filter((t) => t.name === 'draft_action').at(-1)?.result?.data).uncertainty
      const base = draftAction(d)
      const action = str(draft.type) === 'create_invoice' || str(draft.type) === 'send_reminder' || str(draft.type) === 'none'
        ? { ...base, ...draft, line_items: Array.isArray(draft.line_items) ? draft.line_items : base.line_items, amount: num(draft.amount) ?? base.amount }
        : base
      const claims: { text: string; evidence_node_ids: string[] }[] = Array.isArray(toolClaims)
        ? (toolClaims as { text?: unknown; evidence_node_ids?: unknown }[])
            .filter((x) => typeof x?.text === 'string' && Array.isArray(x.evidence_node_ids) && x.evidence_node_ids.length > 0)
            .map((x) => ({ text: String(x.text), evidence_node_ids: (x.evidence_node_ids as unknown[]).map(String) }))
        : []
      if (!claims.length) {
        claims.push({ text: `${order} was ordered.`, evidence_node_ids: pick(nodes, /order|gmail|purchase|po pdf/) })
        claims.push(d.correction
          ? { text: `An explicit correction message sets the delivered quantity to ${d.deliveredQty}, superseding earlier figures.`, evidence_node_ids: pick(nodes, /correction/) }
          : { text: `Delivery evidence shows ${qtyText(d)}.`, evidence_node_ids: pick(nodes, /deliver|challan|sheet|dispatch/) })
        claims.push({ text: `No invoice exists for ${ref} in Zoho, including alternate references.`, evidence_node_ids: pick(nodes, /invoice|zoho|alt/) })
      }
      const amt = num(action.amount) ?? 0
      const li = obj(Array.isArray(action.line_items) ? action.line_items[0] : undefined)
      if (action.type === 'create_invoice') {
        claims.push({ text: `Billable under the billing rule: ${num(li.qty) ?? '?'} × ${inr(num(li.rate) ?? 0)} = ${inr(amt)} (validator figure).`, evidence_node_ids: pick(nodes, /billable|billing|rule|deliver|sheet/) })
      }
      const uncertainty = Array.isArray(toolUnc) ? (toolUnc as unknown[]).map(String) : []
      if (injection) uncertainty.push('A message containing instructions to an automated system was ignored as untrusted content.')
      return {
        action,
        claims,
        uncertainty,
        risk: d.correction || amt > 100000 ? 'medium' : 'low',
      }
    }
  }
}

/** Mock timeline decision from the read_case_timeline result: corrections replace, the same challan counts once,
 *  resends and deleted messages never count, "more/aur" adds. Deterministic stand-in for a real model. */
function timelineDecision(input: Record<string, unknown>, turns: ToolTurn[]) {
  const tl = obj(turns.find((t) => t.name === 'read_case_timeline')?.result?.data)
  const nodes = (Array.isArray(tl.nodes) ? tl.nodes : []).map(obj)
  const trig = obj(input.trigger)
  type Ev = { node_id: string; qty: number; role: string; why: string; plain?: boolean }
  const events: Ev[] = []
  const challans = new Map<string, Ev>()
  for (const n of nodes) {
    if (n.qty_kind !== 'delivered') continue
    const q = num(n.qty)
    const id = str(n.node_id)
    if (q == null || !id) continue
    const st = str(n.status) ?? 'active'
    if (st === 'deleted') { events.push({ node_id: id, qty: q, role: 'ignored', why: 'deleted by the sender' }); continue }
    if (st === 'duplicate') { events.push({ node_id: id, qty: q, role: str(n.duplicate_of) ? `duplicate_of:${str(n.duplicate_of)}` : 'ignored', why: 'same photo or message sent again' }); continue }
    if (n.is_correction === true) for (const e of events) if (e.role === 'counts') { e.role = 'replaced'; e.why = 'a later correction gives the total' }
    const ch = str(n.challan_number)
    const e: Ev = { node_id: id, qty: q, role: 'counts', why: n.is_correction === true ? 'correction: new total' : n.is_incremental === true ? 'extra delivery' : ch ? `challan ${ch}` : 'a delivery count' }
    if (ch) {
      const prev = challans.get(ch)
      if (prev) { prev.role = 'replaced'; prev.why = 'same challan seen again' }
      challans.set(ch, e)
    } else if (n.is_incremental !== true && n.is_correction !== true) {
      for (const p of events) if (p.plain && p.role === 'counts') { p.role = 'replaced'; p.why = 'a later full count' }
      e.plain = true
    }
    events.push(e)
  }
  const counts = events.filter((e) => e.role === 'counts')
  const total = counts.length ? counts.reduce((a, e) => a + e.qty, 0) : null
  const tn = nodes.find((n) => n.node_id === trig.node_id) ?? {}
  const kind = str(trig.kind)
  const meaning = kind === 'resend' ? 'duplicate' : kind === 'edit' ? 'edit' : kind === 'delete' ? 'retraction'
    : tn.is_correction === true ? 'correction' : tn.is_incremental === true ? 'extra_delivery' : tn.qty_kind === 'delivered' ? 'delivery' : tn.qty_kind === 'ordered' ? 'order' : 'noise'
  return {
    link: { action: 'existing_case', case_ref: str(tl.case_ref) ?? null, po_ref: str(tl.po_ref) ?? null, why: 'the message is on this case (mock model)' },
    meaning,
    delivered: { total, events: events.map(({ plain: _p, ...e }) => e) },
    memory_patch: str(tl.po_ref) ? { active_po: str(tl.po_ref) } : {},
    confidence: 0.85,
    explanation_for_owner: total == null ? 'No delivery has been reported on this order yet.' : `Delivered so far: ${total}${counts.length > 1 ? ` (${counts.map((e) => e.qty).join(' + ')})` : ''}.`,
  }
}
