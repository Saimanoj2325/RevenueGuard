import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentDecision, ChatMemoryCard, GstAmount, TimelineRow, WhatHappened } from '../WhatHappened';
import { TimelineSteps } from '../TimelineSteps';
import type { GstPreview, TimelineEvent } from '@/lib/v2types';

const TL: TimelineEvent[] = [
  { node_id: 'c1', at: '2026-10-14T05:00:00Z', kind: 'photo', source_label: 'Photo · Dispatch Team', text: 'Challan DC-6101 · 60 nos', status: 'active', challan_number: 'DC-6101', qty: 60, role: 'counts', why: 'First challan.' },
  { node_id: 'm1', at: '2026-10-14T05:10:00Z', kind: 'message', text: 'PO-207 total 100 delivered', status: 'edited', versions: [{ text: 'PO-207 60 delivered', at: '2026-10-14T05:10:00Z' }], qty: 100, role: 'ignored' },
  { node_id: 'c1b', at: '2026-10-15T05:00:00Z', kind: 'photo', text: 'Challan DC-6101 · 60 nos', status: 'duplicate', duplicate_of: 'c1', qty: 60, role: 'duplicate_of:c1' },
  { node_id: 'c2', at: '2026-10-15T06:00:00Z', kind: 'photo', text: 'Challan DC-6102 · 40 nos', status: 'active', qty: 40, role: 'counts' },
  { node_id: 'd1', at: '2026-10-15T06:05:00Z', kind: 'message', text: '50 boxes unloaded', status: 'deleted', qty: 50, role: 'ignored' },
  { node_id: 'v1', at: '2026-10-15T06:10:00Z', kind: 'voice', text: 'baaki 40 box', read_by: 'sarvam', language: 'hi-IN', qty: 40, role: 'ignored' },
];
const PREVIEW: GstPreview = { seller_gstin: 'x', buyer_gstin: 'y', place_of_supply: '36', lines: [{ item: 'Model X', hsn: '8481', qty: 100, rate: 1000, taxable: 100000 }], cgst: 9000, sgst: 9000, igst: 0, round_off: 0, total: 118000, total_words: '', irn_note: null };

describe('What happened timeline', () => {
  const html = renderToStaticMarkup(h(WhatHappened, { timeline: TL }));
  it('shows every badge and the counted total', () => {
    expect(html).toContain('What happened');
    expect(html).toContain('6 messages · 2 not counted · 100 counted');
    expect(html).toContain('Edited');
    expect(html).toContain('Deleted');
    expect(html).toContain('same photo sent again, not counted');
    expect(html).toContain('Read by Sarvam · Hindi');
    expect(html).toContain('Why: </span>First challan.');
    expect(html).toMatch(/data-status="deleted"[\s\S]*?class="[^"]*strike/);
  });
  it('old versions are hidden until tapped', () => {
    expect(html).not.toContain('PO-207 60 delivered');
    const open = renderToStaticMarkup(h(TimelineRow, { e: TL[1], defaultOpen: true }));
    expect(open).toContain('PO-207 60 delivered');
    expect(open).toContain('aria-expanded="true"');
  });
  it('renders nothing for an older API without timeline', () => {
    expect(renderToStaticMarkup(h(WhatHappened, { timeline: undefined }))).toBe('');
    expect(renderToStaticMarkup(h(AgentDecision, { d: null }))).toBe('');
    expect(renderToStaticMarkup(h(ChatMemoryCard, { m: undefined }))).toBe('');
  });
});

describe('Agent decision box', () => {
  it('verified: explanation, tick, GST-inclusive total with pre-GST below', () => {
    const html = renderToStaticMarkup(h(AgentDecision, { d: { delivered_total: 100, verified: true, failed_checks: [], explanation_for_owner: 'Two challans: 60 + 40.' }, preview: PREVIEW }));
    expect(html).toContain('Two challans: 60 + 40.');
    expect(html).toContain('Verified');
    expect(html).toContain('₹1,18,000');
    expect(html).toContain('₹1,00,000 before GST');
  });
  it('failed: Needs a check with the failed checks in plain words, no amount', () => {
    const html = renderToStaticMarkup(h(AgentDecision, { d: { delivered_total: 160, verified: false, failed_checks: ['duplicate_counted', 'total_mismatch'], explanation_for_owner: 'x' }, preview: PREVIEW }));
    expect(html).toContain('Needs a check');
    expect(html).toContain('The same photo or message was counted twice.');
    expect(html).toContain('The total does not add up');
    expect(html).not.toContain('₹1,18,000');
    expect(html).not.toContain('Verified');
  });
  it('GstAmount puts the with-GST figure first', () => {
    const html = renderToStaticMarkup(h(GstAmount, { pre: 100000, total: 118000 }));
    expect(html.indexOf('₹1,18,000')).toBeLessThan(html.indexOf('₹1,00,000 before GST'));
  });
});

describe('Chat memory card', () => {
  it('shows active PO, open questions, pending, summary and other cases (not this one)', () => {
    const html = renderToStaticMarkup(h(ChatMemoryCard, { caseRef: 'RG-1051', m: { label: 'Dispatch Team', active_po: 'PO-207', summary: 'Two trips.', open_questions: ['Is PO-201 going?'], pending: 'PO-201: 52 left', cases: [{ case_ref: 'RG-1046', po_ref: 'PO-201' }, { case_ref: 'RG-1051', po_ref: 'PO-207' }, 'RG-1049'] } }));
    for (const t of ['Chat memory', 'PO-207', 'Two trips.', 'Is PO-201 going?', 'PO-201: 52 left', 'RG-1046', 'RG-1049']) expect(html).toContain(t);
    expect(html).not.toContain('id=RG-1051');
  });
});

describe('Timeline agent steps (Agent activity)', () => {
  it('lists tool, short args, result and why', () => {
    const html = renderToStaticMarkup(h(TimelineSteps, { trace: [
      { run_id: 'r', case_id: 'RG-1051', agent: 'timeline', type: 'tool_call', data: { step: 1, tool: 'propose_timeline', args: { case_ref: 'RG-1051', total: 100 }, why: '60 + 40' }, ts: '2026-10-15T06:00:00Z' },
      { run_id: 'r', case_id: 'RG-1051', agent: 'timeline', type: 'tool_result', data: { tool: 'propose_timeline', ok: true, summary: 'verifier passed' }, ts: '2026-10-15T06:00:01Z' },
    ] as any }));
    for (const t of ['Timeline agent steps', 'propose_timeline', 'case_ref=RG-1051, total=100', 'verifier passed', '60 + 40']) expect(html).toContain(t);
    expect(renderToStaticMarkup(h(TimelineSteps, { trace: [] }))).toBe('');
  });
});
