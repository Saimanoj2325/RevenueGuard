import { describe, expect, it } from 'vitest';
import { mockBackend } from '../mock/backend';
import { badgesFor, billAmounts, counts, plainCheck, readByLabel, roleLabel, shortArgs, sortTimeline, timelineSteps, withGst } from '../timeline';

describe('timeline helpers', () => {
  it('badges: edited, deleted, duplicate photo, read by Sarvam · Hindi', () => {
    expect(badgesFor({ node_id: 'a', status: 'edited', versions: [{ text: '60' }] }).map((b) => b.label)).toEqual(['Edited']);
    expect(badgesFor({ node_id: 'b', status: 'deleted' })[0]).toMatchObject({ label: 'Deleted', note: 'not counted' });
    expect(badgesFor({ node_id: 'c', status: 'duplicate', kind: 'photo' })[0].note).toBe('same photo sent again, not counted');
    expect(readByLabel({ read_by: 'sarvam', language: 'hi-IN' })).toBe('Sarvam · Hindi');
    expect(readByLabel({ read_by: null, language: 'unknown' })).toBeNull();
    expect(badgesFor({ node_id: 'd' })).toEqual([]); // older API: no status at all
  });
  it('deleted and duplicate never count, even if the role says counts', () => {
    expect(counts({ node_id: 'a', role: 'counts', qty: 60 })).toBe(true);
    expect(counts({ node_id: 'b', role: 'counts', status: 'deleted' })).toBe(false);
    expect(counts({ node_id: 'c', role: 'counts', status: 'duplicate' })).toBe(false);
    expect(roleLabel('duplicate_of:n1')?.label).toMatch(/not counted/);
    expect(roleLabel(null)).toBeNull();
  });
  it('failed checks read as plain words', () => {
    expect(plainCheck('total_mismatch')).toBe('The total does not add up from the counted messages.');
    expect(plainCheck('deleted_node_counted')).toBe('A deleted message was counted.');
    expect(plainCheck('confidence_below_0.7')).toBe('The agent was not sure enough.');
    expect(plainCheck('Challan number is blurred.')).toBe('Challan number is blurred.');
  });
  it('GST: 100 × ₹1,000 + 18% = ₹1,18,000', () => {
    expect(withGst(100000)).toBe(118000);
    expect(billAmounts({ qty: 100, rate: 1000 })).toEqual({ pre: 100000, total: 118000 });
    expect(billAmounts({})).toBeNull();
  });
  it('sorts by time and drops rows without node_id', () => {
    const t = sortTimeline([{ node_id: 'b', at: '2026-10-02' }, { node_id: '', at: '2026-10-01' } as any, { node_id: 'a', at: '2026-10-01' }, { node_id: 'c' }]);
    expect(t.map((x) => x.node_id)).toEqual(['a', 'b', 'c']);
    expect(sortTimeline(undefined)).toEqual([]);
  });
  it('pairs Timeline agent tool calls with results and why', () => {
    const tr = [
      { run_id: 'r', agent: 'timeline', type: 'tool_call', data: { step: 1, tool: 'read_case_timeline', args: { case_ref: 'RG-1051' }, why: 'see all' }, ts: '1' },
      { run_id: 'r', agent: 'timeline', type: 'tool_result', data: { tool: 'read_case_timeline', ok: true, summary: '7 nodes' }, ts: '2' },
      { run_id: 'x', agent: 'triage', type: 'tool_call', data: { tool: 'other' }, ts: '3' },
    ];
    expect(timelineSteps(tr)).toEqual([{ run_id: 'r', step: 1, tool: 'read_case_timeline', args: 'case_ref=RG-1051', result: '7 nodes', why: 'see all', ok: true, ts: '1' }]);
    expect(shortArgs({ a: 'x'.repeat(100) }).length).toBeLessThanOrEqual(90);
  });
});

describe('demo backend: CONTRACT_V3 timeline story (PO-207)', () => {
  const mb = mockBackend();
  it('shows 60 + 40 = 100, duplicate, edit, delete, Sarvam Hindi voice, and ₹1,18,000 with GST', async () => {
    await mb.ready;
    const s = await mb.handle('GET', '/cases/RG-1051/summary', undefined, 'mock.' + Buffer.from('finance@demo.in').toString('base64'));
    const tl = s.timeline as any[];
    expect(tl.filter((e) => counts(e)).map((e) => e.qty)).toEqual([60, 40]);
    expect(tl.some((e) => e.status === 'duplicate' && e.kind === 'photo')).toBe(true);
    expect(tl.find((e) => e.status === 'edited').versions[0].text).toMatch(/60/);
    expect(tl.find((e) => e.status === 'edited').text).toMatch(/100/);
    expect(tl.some((e) => e.status === 'deleted')).toBe(true);
    expect(readByLabel(tl.find((e) => e.read_by))).toBe('Sarvam · Hindi');
    expect(s.timeline_decision).toMatchObject({ delivered_total: 100, verified: true });
    expect(s.timeline_decision.explanation_for_owner).toMatch(/60.*40/);
    expect(s.chat_memory.active_po).toBe('PO-207');
    expect(s.invoice_preview.total).toBe(118000);
    expect(billAmounts({ preview: s.invoice_preview })).toEqual({ pre: 100000, total: 118000 });
    const trace = await mb.handle('GET', '/cases/RG-1051/trace', undefined, 'mock.' + Buffer.from('finance@demo.in').toString('base64'));
    const steps = timelineSteps(trace);
    expect(steps.map((x) => x.tool)).toContain('propose_timeline');
    expect(steps.every((x) => x.why && x.result)).toBe(true);
  }, 30000);
});
