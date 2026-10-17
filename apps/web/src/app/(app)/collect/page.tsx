'use client';
import clsx from 'clsx';
import { Moon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ApproveActions } from '@/components/money/ApproveActions';
import { Card, EmptyState, ErrorState, Money, PageHead, Skeleton, StatStrip, plainError } from '@/components/ui';
import { api } from '@/lib/api';
import { dayMonth, inr } from '@/lib/format';
import { useLive } from '@/lib/hooks';
import { useT } from '@/i18n';
import type { ApprovalCard, ChaseRow } from '@/lib/v2types';

const refresh = (e: { type: string }) => ['case.updated', 'approval.updated'].includes(e.type);
const BUCKETS = ['all', '0-7', '8-30', '31-60', '60+'] as const;
const STAGES = [{ s: 7, label: 'Polite' }, { s: 15, label: 'Friendly' }, { s: 30, label: 'Firm' }];
const sentCount = (r: ChaseRow) => (r.reminder.status === 'none' || r.reminder.status === 'draft' ? Math.max(0, [7, 15, 30].indexOf(r.reminder.stage)) : [7, 15, 30].indexOf(r.reminder.stage) + 1);
const lateTone = (d: number) => (d > 30 ? 'text-red' : d > 14 ? 'text-amber' : 'text-ink');
function nextStep(r: ChaseRow) {
  if (r.snoozed_until) return `Snoozed till ${dayMonth(r.snoozed_until)}`;
  if (r.approval_id) return 'Reminder drafted · needs your OK';
  if (r.reminder.status === 'replied') return 'Check on the promised date';
  if (sentCount(r) >= 3) return 'Call them, or escalate';
  const next = [7, 15, 30].find((s) => s > (r.reminder.stage || 0)) ?? 30;
  return r.days_late >= next ? `Reminder ${sentCount(r) + 1} due now` : `Reminder ${sentCount(r) + 1} at ${next} days`;
}

function Ladder({ r }: { r: ChaseRow }) {
  const n = sentCount(r);
  return (
    <div>
      <div className="flex gap-1">{[0, 1, 2].map((i) => <span key={i} className={clsx('h-[4px] w-6', i < n ? 'bg-ink' : 'bg-rule-2')} />)}</div>
      <div className="mt-1 text-[12px] text-ink-3">{n} of 3 sent</div>
    </div>
  );
}

function UpiText({ text }: { text: string }) {
  const parts = text.split(/(upi:\/\/pay\?\S+)/);
  return <>{parts.map((p, i) => (p.startsWith('upi://') ? <a key={i} href={p} className="break-all text-[#24466B] underline-offset-2 hover:underline">{p}</a> : <span key={i}>{p}</span>))}</>;
}

function Panel({ row, card, onChange }: { row: ChaseRow; card: ApprovalCard | null; onChange: () => void }) {
  const [stage, setStage] = useState(row.days_late >= 30 ? 30 : row.days_late >= 15 ? 15 : 7);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [snooze, setSnooze] = useState(false);
  const [days, setDays] = useState(7);
  const [reason, setReason] = useState('');
  useEffect(() => { setStage(row.days_late >= 30 ? 30 : row.days_late >= 15 ? 15 : 7); setSnooze(false); setErr(null); }, [row.invoice_number, row.days_late]);
  async function draft() {
    setBusy(true); setErr(null);
    try { await api.draftReminder(row.invoice_number, stage); onChange(); } catch (e: any) { setErr(plainError(e?.message)); } finally { setBusy(false); }
  }
  async function doSnooze() {
    setBusy(true); setErr(null);
    try { await api.snooze(row.invoice_number, days, reason); setSnooze(false); onChange(); } catch (e: any) { setErr(plainError(e?.message)); } finally { setBusy(false); }
  }
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {STAGES.map((s) => <button key={s.s} disabled={!!card} onClick={() => setStage(s.s)} className={clsx('pill px-2.5 py-1 text-[12.5px] disabled:cursor-default', (card ? (card.message?.includes('Please pay today') ? 30 : 7) : stage) === s.s && 'pill-on')}>{s.label}</button>)}
        </div>
        <span className="text-[12px] text-ink-3">EN · हि · తె</span>
      </div>
      {card ? (
        <>
          <div className="whitespace-pre-line rounded-md bg-[#DCF8D4] px-4 py-3 text-[13.5px] leading-relaxed"><UpiText text={card.message ?? ''} /></div>
          <p className="mt-2 text-[12.5px] text-ink-3">Goes to {row.customer} on WhatsApp after your approval · payment link for {inr(row.amount)} included.</p>
          <div className="mt-3"><ApproveActions card={card} onDone={onChange} extra={<button className="btn-ghost" onClick={() => setSnooze(true)}><Moon size={13} />Snooze</button>} /></div>
        </>
      ) : (
        <>
          <div className="rounded-md border border-dashed border-rule-2 px-4 py-3 text-[13px] text-ink-2">
            No reminder drafted yet. We will write a {STAGES.find((s) => s.s === stage)?.label.toLowerCase()} WhatsApp with a UPI payment link for {inr(row.amount)}. Nothing goes out until someone approves it.
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn" disabled={busy} onClick={draft}>Draft reminder</button>
            <button className="btn-ghost" onClick={() => setSnooze(true)}><Moon size={13} />Snooze</button>
            <Link href={`/customers?id=${row.customer_id}`} className="btn-ghost">Customer</Link>
          </div>
        </>
      )}
      {snooze && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded bg-paper p-3 text-[13px]">
          <span>Snooze for</span>
          <select className="select w-auto py-1 text-[13px]" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
          <input className="input min-w-[180px] flex-1 py-1 text-[13px]" placeholder="Reason (e.g. promised Friday)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn btn-sm" disabled={busy} onClick={doSnooze}>Snooze</button>
          <button className="btn-ghost btn-sm" onClick={() => setSnooze(false)}>Cancel</button>
        </div>
      )}
      {err && <div className="mt-2 text-[12.5px] text-red">{err}</div>}
    </Card>
  );
}

export default function CollectPage() {
  const t = useT();
  const [bucket, setBucket] = useState<(typeof BUCKETS)[number]>('all');
  const q = useLive(() => api.collect('all'), [], refresh, 300);
  const cards = useLive(() => api.approvalCards('pending'), [], refresh, 300);
  const dash = useLive(() => api.dashboard('month'), [], refresh, 500);
  const settings = useLive(() => api.settings().catch(() => null), []);
  const [selId, setSelId] = useState<string | null>(null);
  const all = q.data?.items ?? [];
  const inB = (r: ChaseRow, b: string) => b === 'all' || (b === '0-7' ? r.days_late <= 7 : b === '8-30' ? r.days_late > 7 && r.days_late <= 30 : b === '31-60' ? r.days_late > 30 && r.days_late <= 60 : r.days_late > 60);
  const rows = useMemo(() => all.filter((r) => inB(r, bucket)), [all, bucket]);
  const sel = rows.find((r) => r.invoice_number === selId) ?? rows.find((r) => r.approval_id) ?? rows[0] ?? null;
  const card = sel?.approval_id ? (cards.data ?? []).find((c) => c.id === sel.approval_id) ?? null : null;
  const reload = () => { q.reload(); cards.reload(); dash.reload(); };
  const ladder = settings.data?.reminder_ladder ?? [7, 15, 30];

  const total = all.reduce((s, r) => s + r.amount, 0);
  const late30 = all.filter((r) => r.days_late > 30);
  return (
    <div>
      <PageHead title={t('collect.title')} sub={t('collect.sub')} />
      {!q.data ? (q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : <Skeleton className="h-[120px]" />) : (
        <StatStrip size={32} stats={[
          { label: 'Overdue', labelTone: 'red', value: total, note: `${all.length} invoices` },
          { label: 'Over 30 days late', labelTone: 'amber', value: late30.reduce((s, r) => s + r.amount, 0), note: `${late30.length} invoice${late30.length === 1 ? '' : 's'}` },
          { label: 'Collected this month', labelTone: 'green', value: dash.data?.flow.paid ?? 0, note: 'payments matched in the bank' },
          { label: 'Reminders waiting', labelTone: 'ink', text: String(all.filter((r) => r.approval_id).length), note: 'drafted, need your OK' },
        ]} />
      )}

      <div className="mt-6 grid gap-x-8 gap-y-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0">
          <div className="mb-3 flex flex-wrap gap-1.5">
            {BUCKETS.map((b) => <button key={b} className={clsx('pill', bucket === b && 'pill-on')} onClick={() => setBucket(b)}>{b === 'all' ? 'All overdue' : `${b} days`} {all.filter((r) => inB(r, b)).length}</button>)}
          </div>
          {!q.data ? <Skeleton lines={5} /> : rows.length === 0 ? <Card><EmptyState title="Nobody is late in this group." hint="Paid invoices drop off this list automatically when the bank shows the money." /></Card> : (
            <>
              <div className="card hidden overflow-x-auto sm:block">
                <table className="tbl min-w-[660px] [&_td]:px-3 [&_th]:px-3">
                  <thead><tr><th>Customer</th><th>Late</th><th>Reminders</th><th>Last update</th><th>Next step</th><th className="text-right">Amount</th><th /></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.invoice_number} onClick={() => setSelId(r.invoice_number)} className={clsx('cursor-pointer hover:bg-[#FBF9F3]', sel?.invoice_number === r.invoice_number && 'bg-[#FBF9F3]', r.snoozed_until && 'text-ink-3')}>
                        <td><div className="font-semibold">{r.customer}</div><div className="mono text-[12px] text-ink-3">{r.invoice_number}</div></td>
                        <td className={clsx('whitespace-nowrap font-medium', lateTone(r.days_late))}>{r.days_late} days</td>
                        <td><Ladder r={r} /></td>
                        <td className="max-w-[150px] text-[13px]">{r.note ?? (r.reminder.status === 'none' ? 'No reminder yet' : `Reminder ${r.reminder.status}`)}</td>
                        <td className="max-w-[150px] text-[13px]">{nextStep(r)}</td>
                        <td className="text-right"><Money value={r.amount} className="text-[15px] font-semibold" /></td>
                        <td className="text-right">{r.approval_id ? <button className="btn btn-sm" onClick={() => setSelId(r.invoice_number)}>Review</button> : <button className="btn-ghost btn-sm" onClick={() => setSelId(r.invoice_number)}>Open</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-2.5 sm:hidden">
                {rows.map((r) => (
                  <div key={r.invoice_number} className={clsx('card p-4', sel?.invoice_number === r.invoice_number && 'border-ink-3')}>
                    <div className="flex justify-between gap-2"><b>{r.customer.replace(' Pvt Ltd', '')}</b><Money value={r.amount} className="font-semibold" /></div>
                    <div className={clsx('mt-0.5 text-[13px]', lateTone(r.days_late))}>{r.days_late} days late · {r.note ?? nextStep(r)}</div>
                    <div className="mt-3 flex gap-2">
                      {r.approval_id ? <button className="btn-green btn-sm" onClick={() => setSelId(r.invoice_number)}>Send reminder</button> : <button className="btn-ghost btn-sm" onClick={() => setSelId(r.invoice_number)}>Remind</button>}
                      <Link href={`/customers?id=${r.customer_id}`} className="btn-ghost btn-sm">View</Link>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
        <aside className="min-w-0">
          {sel && (
            <>
              <div className="mb-3 flex items-baseline justify-between"><h2 className="text-[15px] font-semibold">Reminder {Math.min(3, sentCount(sel) + 1)} · {sel.invoice_number}</h2><span className="text-[12.5px] text-ink-3">{card ? 'needs your OK' : sel.snoozed_until ? 'snoozed' : 'not drafted'}</span></div>
              <Panel row={sel} card={card} onChange={reload} />
            </>
          )}
          <Card className="mt-4 p-4 sm:p-5">
            <div className="font-semibold">Reminder plan</div>
            <p className="mt-1 text-[13px] text-ink-3">{ladder[0]} days late: polite · {ladder[1]} days: friendly · {ladder[2]} days: firm · then flag to you. Every message needs approval. Change it in <Link href="/settings" className="underline">Settings</Link>.</p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
