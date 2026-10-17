/** End-to-end runs of the PO-184 demo story on BOTH engines (dsh via @deepseek-ai/* packages, and builtin). */
import { describe, expect, it } from 'vitest'
import { Runner } from '../src/runner.js'
import type { ModelClient, ModelRequest, ModelResponse } from '../src/core/types.js'
import { fakeApi, silent, testConfig } from './helpers.js'

// Snapshots shaped like the API's case snapshot (services/api/app/case_service.py snapshot()).
const NODES = [
  { id: 'ev-gmail-order-1', kind: 'email', source: 'gmail', title: 'PO-184 order email', fields: { po_ref: 'PO-184', qty_ordered: 100, rate: 1000, amount: 100000, item: 'Model X', customer: 'Example Customer Pvt Ltd' } },
  { id: 'ev-sheet-4', kind: 'delivery_record', source: 'sheets', title: 'Delivery sheet 60/100', fields: { po_ref: 'PO-184', qty_delivered: 60 } },
  { id: 'ev-zoho-inv-5', kind: 'search_result', source: 'zoho', title: 'Negative finding · zoho_get_invoices: no invoice for PO-184' },
]
const CORRECTION = { id: 'ev-wa-correction-6', kind: 'chat_message', source: 'whatsapp', title: 'WhatsApp', excerpt: 'Correction: 70 delivered', fields: { po_ref: 'PO-184', qty_delivered: 70, is_correction: true } }
const SNAP = (nodes: unknown[]) => ({ case: { po_ref: 'PO-184', customer: 'Example Customer Pvt Ltd', amount: 100000 }, facts: { order_qty: 100, rate: 1000, order_amount: 100000, item: 'Model X', customer_name: 'Example Customer Pvt Ltd' }, evidence: nodes })

let n = 0
const req = (agent: string, input: Record<string, unknown> = {}, budget?: Record<string, number>) => ({ run_id: `run-${++n}`, case_id: 'RG-1042', correlation_id: 'corr', agent: agent as never, input, ...(budget ? { budget } : {}) })

async function mkRunner(engine: 'dsh' | 'builtin', opts: { correction?: boolean; model?: ModelClient; override?: Record<string, unknown> } = {}) {
  const api = fakeApi({ correction: opts.correction, override: opts.override })
  const runner = new Runner(testConfig({ HARNESS_ENGINE: engine, HARNESS_ENGINE_FALLBACK: 'false' }), silent, { fetchImpl: api.fetchImpl, model: opts.model as never })
  await runner.init()
  return { runner, api }
}

for (const engine of ['dsh', 'builtin'] as const) {
  describe(`engine=${engine} (MOCK_LLM, derived from snapshot: PO-184 story + PO-185)`, () => {
    it('triage -> High / missing_invoice, events streamed in order', async () => {
      const { runner, api } = await mkRunner(engine)
      expect(runner.engine).toBe(engine)
      const r = await runner.run(req('triage'))
      expect(r.status).toBe('finished')
      expect(r.output).toMatchObject({ exception_type: 'missing_invoice', severity: 'high' })
      const types = api.events.filter((e) => e.run_id === r.run_id).map((e) => e.type)
      expect(types[0]).toBe('step_started')
      expect(types.at(-1)).toBe('run_finished')
      expect(types.filter((t) => t === 'step_started').length).toBe(types.filter((t) => t === 'step_finished').length)
      expect(types).toContain('model_call')
      expect(types).toContain('tool_call')
      expect(api.toolCalls.map((t) => t.name)).toEqual(['laya_decide', 'case_attach_or_open'])
    })

    it('investigation -> alt ids, credit notes, delivery 60, billing rule; gap_closed', async () => {
      const { runner } = await mkRunner(engine)
      const r = await runner.run(req('investigation'))
      expect(r.status).toBe('finished')
      const out = r.output as { steps: { tool: string }[]; stop_reason: string; findings: string[] }
      expect(out.steps.map((s) => s.tool)).toEqual(['search_alt_ids', 'search_credit_notes', 'sheets_read_delivery', 'get_billing_rules'])
      expect(out.stop_reason).toBe('gap_closed')
      expect(out.findings.join(' ')).toMatch(/60 of 100/)
    })

    it('resolution -> create_invoice ₹60,000; ₹70,000 when evidence includes the correction', async () => {
      const a = await mkRunner(engine)
      const r60 = await a.runner.run(req('resolution', SNAP(NODES)))
      expect(r60.status).toBe('finished')
      expect(r60.output).toMatchObject({ action: { type: 'create_invoice', amount: 60000 } })
      const b = await mkRunner(engine)
      const r70 = await b.runner.run(req('resolution', SNAP([...NODES, CORRECTION])))
      expect(r70.output).toMatchObject({ action: { type: 'create_invoice', amount: 70000, line_items: [{ item: 'Model X', qty: 70, rate: 1000 }] } })
      const claims = (r70.output as { claims: { evidence_node_ids: string[] }[] }).claims
      expect(claims.every((c) => c.evidence_node_ids.length > 0)).toBe(true)
      expect(claims.flatMap((c) => c.evidence_node_ids)).toContain('ev-wa-correction-6')
    })

    it('generalised mock: PO-185 (₹2,00,000) derives refs/qty/amount from the snapshot, never PO-184', async () => {
      const ev185 = [
        { id: 'ev185-mail', kind: 'email', source: 'gmail', title: 'PO-185 order confirmation - Model Y', fields: { po_ref: 'PO-185', qty_ordered: 250, rate: 800, amount: 200000, item: 'Model Y', customer: 'Other Traders LLP' } },
        { id: 'ev185-sheet', kind: 'delivery_record', source: 'sheets', title: 'Delivery sheet row 3: PO-185', fields: { po_ref: 'PO-185', qty_delivered: 250 } },
      ]
      const snap = { case: { po_ref: 'PO-185', customer: 'Other Traders LLP', amount: 200000 }, evidence: ev185,
        facts: { po_ref: 'PO-185', order_qty: 250, rate: 800, order_amount: 200000, delivered_qty: 250, item: 'Model Y', customer_name: 'Other Traders LLP', billable: { amount: 200000, billable_qty: 250, rate: 800 } } }
      const t = await mkRunner(engine)
      const tri = await t.runner.run(req('triage', { case: { po_ref: null }, evidence: ev185 }))
      expect(tri.status).toBe('finished')
      expect(tri.output).toMatchObject({ refs: { po: 'PO-185', customer: 'Other Traders LLP', amount: 200000, qty: 250 } })
      expect(t.api.toolCalls.find((c) => c.name === 'case_attach_or_open')?.args).toMatchObject({ refs: { po: 'PO-185' } })
      const i = await mkRunner(engine)
      const inv = await i.runner.run(req('investigation', snap))
      expect(inv.status).toBe('finished')
      expect((inv.output as { findings: string[] }).findings.join(' ')).toMatch(/250 of 250/)
      expect(i.api.toolCalls.filter((c) => c.name === 'search_alt_ids').map((c) => c.args)).toEqual([{ ref: 'PO-185' }])
      const r = await mkRunner(engine)
      const res = await r.runner.run(req('resolution', snap))
      expect(res.status).toBe('finished')
      expect(res.output).toMatchObject({ action: { type: 'create_invoice', reference: 'PO-185', customer_name: 'Other Traders LLP', amount: 200000, line_items: [{ item: 'Model Y', qty: 250, rate: 800 }] } })
      for (const out of [tri.output, inv.output, res.output]) expect(JSON.stringify(out)).not.toMatch(/PO-184|Model X|Example Customer/)
    })

    it('resolution prefers the validator-backed draft_action result (amount, line items, cited claims) from the API', async () => {
      const { runner } = await mkRunner(engine, {
        override: { draft_action: { data: { action: { type: 'create_invoice', customer_id: 'zc-9', customer_name: 'Acme', reference: 'PO-9', line_items: [{ item: 'Bolt', qty: 7, rate: 50 }], amount: 350 }, claims: [{ text: 'Order PO-9: 10 units', evidence_node_ids: ['ev-9'] }], uncertainty: ['3 units pending'] }, evidence_node_ids: ['ev-9'] } },
      })
      const res = await runner.run(req('resolution', { case: { po_ref: 'PO-9' }, evidence: [{ id: 'ev-9', kind: 'email', source: 'gmail', title: 'PO-9' }] }))
      expect(res.output).toMatchObject({ action: { reference: 'PO-9', customer_id: 'zc-9', amount: 350, line_items: [{ item: 'Bolt', qty: 7, rate: 50 }] }, uncertainty: ['3 units pending'] })
      expect((res.output as { claims: { evidence_node_ids: string[] }[] }).claims[0]).toMatchObject({ evidence_node_ids: ['ev-9'] })
    })

    it('garbage output is repaired (≤2) or fails with invalid_output', async () => {
      const { runner } = await mkRunner(engine)
      const fixed = await runner.run(req('triage', { _mock: { garbage_outputs: 2 } }))
      expect(fixed).toMatchObject({ status: 'finished', repairs: 2 })
      const broken = await runner.run(req('triage', { _mock: { garbage_outputs: 3 } }))
      expect(broken).toMatchObject({ status: 'failed', reason: 'invalid_output', repairs: 2 })
    })

    it('budget: investigation stops with stop_reason budget; triage fails with reason budget', async () => {
      const { runner, api } = await mkRunner(engine)
      const inv = await runner.run(req('investigation', {}, { max_steps: 2 }))
      expect(inv).toMatchObject({ status: 'finished', stop_reason: 'budget' })
      expect((inv.output as { steps: unknown[] }).steps).toHaveLength(2)
      const tri = await runner.run(req('triage', {}, { max_steps: 1 }))
      expect(tri).toMatchObject({ status: 'failed', reason: 'budget' })
      const types = api.events.filter((e) => e.run_id === tri.run_id).map((e) => e.type)
      expect(types.filter((t) => t === 'step_started').length).toBe(types.filter((t) => t === 'step_finished').length)
    })

    it('a model asking for a non-allowed / write tool is denied by policy and never reaches the API', async () => {
      // scripted model: first asks for zoho_create_invoice, then answers
      let call = 0
      const model: ModelClient = {
        async chat(r: ModelRequest): Promise<ModelResponse> {
          call++
          const base = { usage: { input_tokens: 10, output_tokens: 10 }, provider: 'scripted', model: 'x', latency_ms: 1, cost_inr: 0, fallbacks: [] }
          if (call === 1) return { ...base, content: null, tool_calls: [{ id: 'bad1', type: 'function', function: { name: 'gmail_search', arguments: '{"query":"PO-184"}' } }] }
          const last = r.messages.at(-1)
          expect(last && last.role === 'tool' ? last.content : '').toMatch(/not on the resolution agent allow-list|policy|not found|unknown/i)
          return { ...base, content: JSON.stringify({ action: { type: 'none', customer_id: null, customer_name: null, reference: null, line_items: [], amount: 0 }, claims: [{ text: 'x', evidence_node_ids: ['ev-sheet-4'] }], uncertainty: ['blocked'], risk: 'high' }), tool_calls: [] }
        },
      }
      const { runner, api } = await mkRunner(engine, { model })
      const r = await runner.run(req('resolution', SNAP(NODES)))
      expect(r.status).toBe('finished')
      expect(api.toolCalls).toHaveLength(0)
    })
  })
}
