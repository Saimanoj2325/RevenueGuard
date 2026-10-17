import { describe, expect, it } from 'vitest';
import { mockBackend } from '../mock/backend';

const tok = (email: string) => 'mock.' + Buffer.from(email).toString('base64');
const FIN = tok('finance@demo.in'), OPS = tok('ops@demo.in');

describe('demo backend: CONTRACT_V2 story', () => {
  const mb = mockBackend();
  const h = (m: string, p: string, b?: any, t = FIN) => mb.handle(m, p, b, t);

  it('seeds the PO-184 story: ₹70,000 waiting, ₹60,000 approval expired, PO-185 at 1 of 2', async () => {
    await mb.ready;
    const s = await h('GET', '/cases/RG-1042/summary');
    expect(s.invoice_preview.total).toBe(82600);
    expect(s.invoice_preview.cgst + s.invoice_preview.sgst).toBe(12600);
    expect(s.callouts.map((c: any) => c.kind)).toEqual(expect.arrayContaining(['approval_expired', 'quarantined']));
    const cards = await h('GET', '/approvals?status=pending');
    const po185 = cards.find((a: any) => a.card.po_ref === 'PO-185').card;
    expect(po185.approvers_needed).toBe(2);
    expect(po185.approvals.length).toBe(1);
  }, 30000);

  it('approving PO-184 creates INV-2231, verifies it and moves the counters', async () => {
    const before = await h('GET', '/dashboard/summary');
    const a = (await h('GET', '/approvals?status=pending')).find((x: any) => x.card.po_ref === 'PO-184');
    await expect(h('POST', `/approvals/${a.id}/approve`, { comment: 'x' }, OPS)).rejects.toThrow(/role/);
    await h('POST', `/approvals/${a.id}/approve`, { comment: 'ok' });
    const t0 = Date.now();
    while (mb.db.cases['RG-1042'].case.state !== 'CLOSED' && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200));
    const after = await h('GET', '/dashboard/summary');
    expect(after.not_billed.amount).toBe(before.not_billed.amount - 70000);
    expect(after.recovered.amount).toBe(before.recovered.amount + 82600);
    expect(mb.db.biz.invoices.some((i: any) => i.number === 'INV-2231' && i.amount === 82600)).toBe(true);
  }, 30000);

  it('correcting a fact expires the open approval and re-runs the validator', async () => {
    const pending = (await h('GET', '/approvals?status=pending')).find((x: any) => x.card.po_ref === 'PO-198');
    await h('POST', '/cases/RG-1045/facts/delivered/correct', { value: '100', note: 'recount' }, OPS);
    const old = (await h('GET', '/approvals')).find((x: any) => x.id === pending.id);
    expect(old.status).toBe('expired');
    const s = await h('GET', '/cases/RG-1045/summary');
    expect(s.approval.amount).toBe(100000);
  });

  it('ask refuses writes and answers money questions from records', async () => {
    const w = await h('POST', '/ask', { question: 'approve PO-201 now' });
    expect(w.answer).toMatch(/only read/);
    const a = await h('POST', '/ask', { question: 'Which customers owe me more than ₹1 lakh?' });
    expect(a.table.rows.length).toBeGreaterThan(0);
  });
});
