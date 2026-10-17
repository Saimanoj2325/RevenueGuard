import { describe, expect, it } from 'vitest'
import { groundingErrors, parseModelJson, repairPrompt, validateOutput } from '../src/plugins/output-schema.js'

const triage = { exception_type: 'missing_invoice', severity: 'high', genuine_prob: 0.9, needs_review_prob: 0.3, laya: {}, refs: { po: 'PO-184', customer: null, amount: 100000, qty: 100 }, summary: 's' }
const resolution = {
  action: { type: 'create_invoice', customer_id: null, customer_name: 'Example Customer Pvt Ltd', reference: 'PO-184', line_items: [{ item: 'Model X', qty: 60, rate: 1000 }], amount: 60000 },
  claims: [{ text: 'delivered 60', evidence_node_ids: ['ev-sheet-4'] }],
  uncertainty: [],
  risk: 'low',
}

describe('output-schema plugin', () => {
  it('accepts valid outputs for each agent', () => {
    expect(validateOutput('triage', JSON.stringify(triage)).ok).toBe(true)
    expect(validateOutput('evidence', '{"nodes_added":["a"],"missing_links":["invoice"],"summary":"x"}').ok).toBe(true)
    expect(validateOutput('investigation', '{"steps":[{"tool":"search_alt_ids","why":"w","added_evidence":false,"evidence_node_ids":[]}],"findings":[],"stop_reason":"gap_closed","conflict":false}').ok).toBe(true)
    expect(validateOutput('resolution', JSON.stringify(resolution)).ok).toBe(true)
  })
  it('parses fenced / prose-wrapped JSON', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseModelJson('Here you go: {"a":{"b":"}"}} thanks')).toEqual({ a: { b: '}' } })
  })
  it('rejects schema violations with readable errors', () => {
    const bad = validateOutput('triage', JSON.stringify({ ...triage, severity: 'urgent', genuine_prob: 2 }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.join('\n')).toMatch(/severity[\s\S]*genuine_prob/)
    expect(validateOutput('resolution', 'not json').ok).toBe(false)
    const uncited = validateOutput('resolution', JSON.stringify({ ...resolution, claims: [{ text: 'x', evidence_node_ids: [] }] }))
    expect(uncited.ok).toBe(false)
    expect(validateOutput('evidence', '{"nodes_added":[],"missing_links":["shipping"],"summary":"x"}').ok).toBe(false)
  })
  it('grounding: cited evidence must exist and investigation steps must match real tool calls', () => {
    const ctx = { calledTools: new Set(['search_alt_ids']), seenIds: new Set(['ev-sheet-4']) }
    expect(validateOutput('resolution', JSON.stringify(resolution), ctx).ok).toBe(true)
    const fake = validateOutput('resolution', JSON.stringify({ ...resolution, claims: [{ text: 'x', evidence_node_ids: ['ev-made-up'] }] }), ctx)
    expect(fake.ok).toBe(false)
    expect(groundingErrors('investigation', { steps: [{ tool: 'get_billing_rules', evidence_node_ids: [] }] }, ctx)[0]).toMatch(/not called/)
  })
  it('repair prompt lists errors and the expected shape', () => {
    const p = repairPrompt('triage', ['severity: Invalid enum value'], 1, 2)
    expect(p).toContain('repair attempt 1/2')
    expect(p).toContain('exception_type')
  })
})
