'use client';
import clsx from 'clsx';
import { Check, MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { BillTag } from '@/components/money/tags';
import { GstAmount } from '@/components/case/WhatHappened';
import { withGst } from '@/lib/timeline';
import { Card, EmptyState, ErrorState, PageHead, ProofList, Skeleton, StatStrip, StatusTag, plainError } from '@/components/ui';
import { api } from '@/lib/api';
import { inr } from '@/lib/format';
import { useLive } from '@/lib/hooks';
import { useAuth } from '@/lib/store';
import { useT } from '@/i18n';
import type { ToBillRow } from '@/lib/v2types';

const REASONS = [
  { id: 'sample', label: 'Free sample' }, { id: 'replacement', label: 'Free replacement' }, { id: 'returned', label: 'Goods returned' },
  { id: 'billed_elsewhere', label: 'Billed in another system' }, { id: 'other', label: 'Other reason' },
];
const refresh = (e: { type: string }) => ['case.updated', 'approval.updated'].includes(e.type);

function NotBillable({ row, onClose, onDone }: { row: ToBillRow; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('replacement');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-[60] grid place-items-end bg-ink/30 sm:place-items-center" onClick={onClose}>
      <div className="w-full max-w-[440px] rounded-t-md border border-rule-2 bg-card p-5 sm:rounded-md" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold">Mark {row.po_ref} as not billable</div>
        <p className="mt-1 text-[13px] text-ink-2">{row.customer} · {inr(row.amount)}. It leaves the To bill list and is written in the audit log.</p>
        <div className="mt-4 space-y-2">
          {REASONS.map((r) => (
            <label key={r.id} className="flex items-center gap-2 text-[13.5px]"><input type="radio" name="reason" checked={reason === r.id} onChange={() => setReason(r.id)} className="accent-[#1A1A17]" />{r.label}</label>
          ))}
          <input className="input mt-2" placeholder="Note (who said so, what was it)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {err && <div className="mt-2 text-[12.5px] text-red">{err}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await api.notBillable(row.case_ref, reason, note); onDone(); } catch (e: any) { setErr(plainError(e?.message)); } finally { setBusy(false); } }}>Mark not billable</button>
        </div>
      </div>
    </div>
  );
}

export default function BillPage() {
  const t = useT();
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const q = useLive(() => api.bill(), [], refresh, 300);
  const dash = useLive(() => api.dashboard('month'), [], refresh, 400);
  const [filter, setFilter] = useState<'all' | 'not_billed' | 'partial' | 'needs_check'>('all');
  const [cust, setCust] = useState('');
  const [older, setOlder] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [menu, setMenu] = useState<string | null>(null);
  const [nb, setNb] = useState<ToBillRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ ok: number; failed: { po: string; detail: string }[] } | null>(null);

  const all = q.data?.items ?? [];
  const rows = useMemo(() => all.filter((r) => (filter === 'all' || r.status === filter) && (!cust || r.customer_id === cust) && r.waiting_days >= older), [all, filter, cust, older]);
  const chosen = rows.filter((r) => sel.has(r.case_ref) && r.approval_id);
  const sum = chosen.reduce((s, r) => s + r.amount, 0);
  const twoApprover = chosen.filter((r) => (r.approvals_needed ?? 1) > 1);
  const count = (f: string) => all.filter((r) => f === 'all' || r.status === f).length;
  const customers = Array.from(new Map(all.map((r) => [r.customer_id, r.customer])).entries());

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (/input|textarea|select/i.test((e.target as HTMLElement)?.tagName)) return;
      if (e.key === 'j') setCursor((c) => Math.min(rows.length - 1, c + 1));
      if (e.key === 'k') setCursor((c) => Math.max(0, c - 1));
      if (e.key === 'x' && rows[cursor]?.approval_id) toggle(rows[cursor].case_ref);
      if (e.key === 'Enter' && rows[cursor]) router.push(`/case?id=${rows[cursor].case_ref}`);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function bulk() {
    setBusy(true); setResults(null);
    try {
      const r = await api.bulkApprove(chosen.map((c) => c.approval_id!));
      const failed = r.results.filter((x) => !x.ok).map((x) => ({ po: chosen.find((c) => c.approval_id === x.id)?.po_ref ?? x.id, detail: plainError(x.detail) }));
      setResults({ ok: r.results.length - failed.length, failed });
      setSel(new Set());
      q.reload(); dash.reload();
    } catch (e: any) { setResults({ ok: 0, failed: [{ po: 'all', detail: plainError(e?.message) }] }); }
    finally { setBusy(false); }
  }

  const d = dash.data;
  const under = all.filter((r) => r.status === 'partial');
  const check = all.filter((r) => r.status === 'needs_check');
  return (
    <div>
      <PageHead title={t('bill.title')} sub={t('bill.sub')} />
      {!q.data ? (q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : <Skeleton className="h-[120px]" />) : (
        <StatStrip size={32} stats={[
          { label: 'Not billed', labelTone: 'red', value: q.data.total_amount, note: `${all.length} deliveries` },
          { label: 'Under-billed', labelTone: 'amber', value: under.reduce((s, r) => s + r.amount, 0), note: `${under.length} invoice${under.length === 1 ? '' : 's'} short` },
          { label: 'Needs check', labelTone: 'amber', value: check.reduce((s, r) => s + r.amount, 0), note: `${check.length} count${check.length === 1 ? '' : 's'} don't match` },
          { label: 'Billed this month', labelTone: 'green', value: d?.flow.billed ?? 0, note: 'from Zoho' },
        ]} />
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(['all', 'not_billed', 'partial', 'needs_check'] as const).map((f) => (
            <button key={f} className={clsx('pill', filter === f && 'pill-on')} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : t(`st.${f}` as any)} {count(f)}</button>
          ))}
        </div>
        <div className="flex gap-2">
          <select className="select w-auto py-1.5 text-[13px]" value={cust} onChange={(e) => setCust(e.target.value)} aria-label="Customer"><option value="">Customer: all</option>{customers.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>
          <select className="select w-auto py-1.5 text-[13px]" value={older} onChange={(e) => setOlder(Number(e.target.value))} aria-label="Older than"><option value={0}>Any age</option><option value={3}>Older than 3 days</option><option value={7}>Older than 7 days</option><option value={14}>Older than 14 days</option></select>
        </div>
      </div>

      {chosen.length > 0 && (
        <div className="sticky top-16 z-10 mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded bg-ink px-4 py-3 text-paper sm:px-5">
          <b className="text-[14.5px]">{chosen.length} selected · {inr(sum)} + GST = {inr(Math.round(sum * 1.18))}</b>
          <span className="flex-1 text-[13px] text-[#CFCABC]">Each still gets its own approval record and check.{twoApprover.length ? ` ${twoApprover.map((r) => r.customer.split(' ')[0]).join(' and ')} ${twoApprover.length > 1 ? 'are' : 'is'} over ₹1 lakh, so ${twoApprover.length > 1 ? 'they also need' : 'it also needs'} a 2nd approver.` : ''}</span>
          <button className="btn-green" disabled={busy || user?.role === 'viewer'} onClick={bulk}><Check size={14} />{busy ? 'Approving…' : `Approve ${chosen.length} invoice${chosen.length > 1 ? 's' : ''}`}</button>
        </div>
      )}
      {results && (
        <div className={clsx('mt-3 rounded border px-4 py-2.5 text-[13px]', results.failed.length ? 'border-amber/40 bg-amber-bg/50' : 'border-green/30 bg-green-bg/60')} role="status">
          {results.ok > 0 && <div className="text-green">{results.ok} approved. Each invoice is created once and checked in Zoho.</div>}
          {results.failed.map((f) => <div key={f.po} className="text-ink"><b>{f.po}:</b> {f.detail}</div>)}
        </div>
      )}

      <div className="mt-3">
        {!q.data ? <Skeleton lines={6} /> : rows.length === 0 ? <Card><EmptyState title="Nothing to bill here." hint={filter === 'all' ? 'Every delivery we can see has an invoice.' : 'Try another filter.'} /></Card> : (
          <>
            <div className="card hidden overflow-x-auto sm:block">
              <table className="tbl min-w-[860px]">
                <thead><tr><th className="w-10" /><th>Customer</th><th>What happened</th><th>Status</th><th>Confidence</th><th>Waiting</th><th className="text-right">To bill (with GST)</th><th className="w-10" /></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.case_ref} className={clsx('cursor-pointer hover:bg-[#FBF9F3]', i === cursor && 'bg-[#FBF9F3]')} onClick={() => router.push(`/case?id=${r.case_ref}`)}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" className="h-4 w-4 accent-[#1A1A17]" checked={sel.has(r.case_ref)} disabled={!r.approval_id} onChange={() => toggle(r.case_ref)} aria-label={`Select ${r.po_ref}`} title={r.approval_id ? 'Select to approve' : 'Check the count first'} />
                      </td>
                      <td><div className="font-semibold">{r.customer}</div><div className="text-[12.5px] text-ink-3">{r.po_ref}</div></td>
                      <td><div className="mb-1.5">{r.headline}</div><ProofList proofs={r.proofs} caseRef={r.case_ref} short /></td>
                      <td><BillTag status={r.status} />{(r.approvals_needed ?? 0) > 1 && <div className="mt-1 text-[11.5px] text-ink-3">{r.approvals_done}/{r.approvals_needed} approvers</div>}</td>
                      <td className={r.status === 'needs_check' ? 'text-amber' : ''}>{r.status === 'needs_check' ? 'Needs check' : 'High'}</td>
                      <td className="whitespace-nowrap text-ink-3">{r.waiting_days} days</td>
                      <td className="text-right"><GstAmount pre={r.amount} total={withGst(r.amount)} className="text-[15px]" /></td>
                      <td className="relative" onClick={(e) => e.stopPropagation()}>
                        <button className="text-ink-3 hover:text-ink" aria-label="More" onClick={() => setMenu(menu === r.case_ref ? null : r.case_ref)}><MoreHorizontal size={16} /></button>
                        {menu === r.case_ref && (
                          <div className="absolute right-2 top-9 z-20 w-[180px] rounded border border-rule-2 bg-card py-1 text-[13px]">
                            <Link href={`/case?id=${r.case_ref}`} className="block px-3 py-1.5 hover:bg-paper">Open case</Link>
                            <button className="block w-full px-3 py-1.5 text-left hover:bg-paper" onClick={() => { setNb(r); setMenu(null); }}>Not billable…</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {(q.data.not_billable ?? []).map((n) => (
                    <tr key={'nb' + n.po_ref} className="text-ink-3">
                      <td /><td><div className="font-semibold text-ink-2">{n.customer}</div><div className="text-[12.5px]">{n.po_ref}</div></td>
                      <td>{REASONS.find((r) => r.id === n.reason)?.label ?? n.reason}{n.note ? ` · ${n.note}` : ''}</td>
                      <td><StatusTag>Not billable</StatusTag></td><td>—</td><td>—</td><td className="text-right">₹0</td><td />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-2.5 sm:hidden">
              {rows.map((r) => (
                <div key={r.case_ref} className="card p-4">
                  <div className="flex items-start gap-3">
                    <input type="checkbox" className="mt-1 h-4 w-4 accent-[#1A1A17]" checked={sel.has(r.case_ref)} disabled={!r.approval_id} onChange={() => toggle(r.case_ref)} aria-label={`Select ${r.po_ref}`} />
                    <Link href={`/case?id=${r.case_ref}`} className="min-w-0 flex-1">
                      <div className="flex justify-between gap-2"><b className="truncate">{r.customer}</b><GstAmount pre={r.amount} total={withGst(r.amount)} /></div>
                      <div className="text-[12.5px] text-ink-3">{r.po_ref} · {r.waiting_days} days</div>
                      <div className="mt-1 text-[13px]">{r.headline}</div>
                      <div className="mt-2 flex items-center gap-2"><BillTag status={r.status} /></div>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 hidden text-[12.5px] text-ink-3 sm:block">Keyboard: j / k to move · x to select · Enter to open · / to search</p>
          </>
        )}
      </div>
      {nb && <NotBillable row={nb} onClose={() => setNb(null)} onDone={() => { setNb(null); q.reload(); }} />}
    </div>
  );
}
