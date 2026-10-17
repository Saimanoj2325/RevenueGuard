/** Timeline agent (CONTRACT_V3 §1): allow-list, strict TimelineDecision schema, and a full mock run on both engines. */
import { describe, expect, it } from 'vitest'
import { TOOL_ALLOW_LIST } from '../src/contract.js'
import { decideToolPolicy, ToolPolicyPlugin } from '../src/plugins/tool-policy.js'
import { validateOutput } from '../src/plugins/output-schema.js'
import { TOOL_SPEC_MAP } from '../src/plugins/rg-tools.js'
import { buildSystemPrompt } from '../src/agents/definitions.js'
import { Runner } from '../src/runner.js'
import { fakeApi, silent, testConfig } from './helpers.js'

const decision = {
  link: { action: 'existing_case', case_ref: 'RG-1042', po_ref: 'PO-184', why: 'same PO' },
  meaning: 'extra_delivery',
  delivered: { total: 100, events: [{ node_id: 'n1', qty: 60, role: 'counts', why: 'challan' }, { node_id: 'n2', qty: 40, role: 'counts', why: 'aur 40' }, { node_id: 'n3', qty: 60, role: 'duplicate_of:n1', why: 'same photo' }] },
  memory_patch: { active_po: 'PO-184' },
  confidence: 0.9,
  explanation_for_owner: '60 + 40 = 100 delivered.',
}

describe('timeline agent', () => {
  it('has exactly its contract tools, each with a spec, and nothing that writes to Zoho/WhatsApp/Gmail', () => {
    expect([...TOOL_ALLOW_LIST.timeline].sort()).toEqual(['propose_timeline', 'read_case_timeline', 'read_chat_memory', 'search_cases', 'sheets_read_delivery', 'whatsapp_search', 'write_chat_memory'])
    for (const t of TOOL_ALLOW_LIST.timeline) {
      expect(decideToolPolicy('timeline', t)).toEqual({ kind: 'allow' })
      expect(TOOL_SPEC_MAP.has(t)).toBe(true)
    }
    expect(decideToolPolicy('timeline', 'zoho_create_invoice').kind).toBe('deny')
    expect(decideToolPolicy('timeline', 'compute_billable').kind).toBe('deny')
    expect(decideToolPolicy('resolution', 'write_chat_memory').kind).toBe('deny')
    expect(new ToolPolicyPlugin(silent).visibleTools('timeline')).toContain('read_case_timeline')
    expect(buildSystemPrompt('timeline')).toContain('ask_which_po')
  })

  it('strict TimelineDecision: valid passes; extra keys, bad role or confidence fail', () => {
    expect(validateOutput('timeline', JSON.stringify(decision)).ok).toBe(true)
    expect(validateOutput('timeline', JSON.stringify({ ...decision, note: 'x' })).ok).toBe(false)
    expect(validateOutput('timeline', JSON.stringify({ ...decision, confidence: 1.4 })).ok).toBe(false)
    const badRole = { ...decision, delivered: { total: 60, events: [{ node_id: 'n1', qty: 60, role: 'maybe', why: 'x' }] } }
    expect(validateOutput('timeline', JSON.stringify(badRole)).ok).toBe(false)
  })

  for (const engine of ['dsh', 'builtin'] as const) {
    it(`mock run on ${engine}: reads the timeline + memory, skips the resent photo and the deleted message`, async () => {
      const nodes = [
        { node_id: 'n1', status: 'active', qty: 60, qty_kind: 'delivered', challan_number: 'CH-101' },
        { node_id: 'n2', status: 'active', qty: 40, qty_kind: 'delivered', is_incremental: true },
        { node_id: 'n3', status: 'duplicate', duplicate_of: 'n1', qty: 60, qty_kind: 'delivered', challan_number: 'CH-101' },
        { node_id: 'n4', status: 'deleted', qty: 90, qty_kind: 'delivered' },
      ]
      const api = fakeApi({ override: { read_case_timeline: { data: { case_ref: 'RG-1042', po_ref: 'PO-184', nodes }, evidence_node_ids: nodes.map((n) => n.node_id) }, read_chat_memory: { data: { chats: [] }, evidence_node_ids: [] } } })
      const runner = new Runner(testConfig({ HARNESS_ENGINE: engine, HARNESS_ENGINE_FALLBACK: 'false' }), silent, { fetchImpl: api.fetchImpl })
      await runner.init()
      const r = await runner.run({ run_id: `tl-${engine}`, case_id: 'RG-1042', correlation_id: 'c', agent: 'timeline', input: { trigger: { kind: 'message', node_id: 'n2', chat_key: 'chat-1' } } } as never)
      expect(r.status).toBe('finished')
      const out = r.output as typeof decision
      expect(out.delivered.total).toBe(100)
      expect(out.meaning).toBe('extra_delivery')
      expect(out.delivered.events.find((e) => e.node_id === 'n3')?.role).toBe('duplicate_of:n1')
      expect(out.delivered.events.find((e) => e.node_id === 'n4')?.role).toBe('ignored')
      expect(api.toolCalls.map((t) => t.name)).toEqual(['read_case_timeline', 'read_chat_memory'])
      expect(api.toolCalls.every((t) => t.agent === 'timeline')).toBe(true)
    })
  }
})
