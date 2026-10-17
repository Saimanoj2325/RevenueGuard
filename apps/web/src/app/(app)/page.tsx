'use client';
import clsx from 'clsx';
import { ArrowRight, Play, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApproveActions, approverLine } from '@/components/money/ApproveActions';
import { BillTag } from '@/components/money/tags';
import {
  Card, DataTable, EmptyState, ErrorState, Journey, LiveFeed, LivePulse, Money, MoneyFlow, ProofList, Skeleton, StatStrip,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useFeed } from '@/lib/feed';
import { inr, weekdayIN } from '@/lib/format';
import { useLive } from '@/lib/hooks';
import { useDemo } from '@/lib/store';
import { useT } from '@/i18n';
import type { ToBillRow } from '@/lib/v2types';

const liveRefresh = (e: { type: string }) => ['case.updated', 'approval.updated', 'checkpoint', 'agent.event'].includes(e.type);

export default function Today() {
  const t = useT();
  const router = useRouter();
  const demo = useDemo();
  const [period, setPeriod] = useState<'month' | '30d' | 'quarter'>('month');
  const q = useLive(() => api.dashboard(period), [period], liveRefresh, 250);
  const lines = useFeed((s) => s.lines);
  const [replay, setReplay] = useState<number>(0);
  const [replayErr, setReplayErr] = useState<string | null>(null);
  const live = useLive(() => (replay ? api.caseSummary('RG-1042').catch(() => null) : Promise.resolve(null)), [replay], liveRefresh, 200);
  useEffect(() => {
    if (!replay) return;
    const tm = setTimeout(() => setReplay(0), 75000);
    return () => clearTimeout(tm);
  }, [replay]);

  const d = q.data;
  const startReplay = async () => {
    setReplayErr(null);
    try { useFeed.getState().clear(); await api.demoReplay(); setReplay(Date.now()); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    catch (e: any) { setReplayErr(e?.message ?? String(e)); }
  };

  const cols = [
    { key: 'c', header: 'Customer', width: '20%', render: (r: ToBillRow) => <div><div className="font-semibold leading-snug">{r.customer}</div><div className="text-[12.5px] text-ink-3">{r.po_ref}</div></div> },
    { key: 'w', header: 'What happened', render: (r: ToBillRow) => <div className="space-y-1.5"><div className="leading-snug">{r.headline}</div><ProofList proofs={r.proofs} caseRef={r.case_ref} max={3} short /></div> },
    { key: 's', header: 'Status', render: (r: ToBillRow) => <BillTag status={r.status} /> },
    { key: 'd', header: 'Waiting', render: (r: ToBillRow) => <span className="whitespace-nowrap text-ink-3">{r.waiting_days} days</span> },
    { key: 'a', header: 'Amount', align: 'right' as const, render: (r: ToBillRow) => <Money value={r.amount} className="text-[15px] font-semibold" /> },
    { key: 'x', header: '', align: 'right' as const, render: (r: ToBillRow) => <Link href={`/case?id=${r.case_ref}`} className={r.status === 'needs_check' ? 'btn-ghost' : 'btn'} onClick={(e) => e.stopPropagation()}>{r.status === 'needs_check' ? 'Check' : 'Review & bill'}</Link> },
  ];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h1">{weekdayIN().replace(/^(\w+) (\d+) (\w+)$/, '$1, $2 $3')}</h1>
          <p className="sub">{t('today.sub')}</p>
        </div>
        {demo && (
          <div className="flex items-center gap-2">
            {replayErr && <span className="text-[12px] text-red">{replayErr}</span>}
            <button className="btn-ghost" onClick={startReplay} disabled={!!replay && live.data?.journey.current !== 'paid'}><Play size={14} strokeWidth={1.8} />{replay && live.data?.journey.current !== 'paid' ? 'Playing PO-184…' : t('today.replay')}</button>
          </div>
        )}
      </div>

      {q.error && !d && <ErrorState error={q.error} onRetry={q.reload} />}
      {!d && !q.error && <Skeleton className="h-[150px]" />}
      {d && (
        <StatStrip firstWide size={44} stats={[
          { label: t('strip.notBilled'), labelTone: 'red', value: d.not_billed.amount, href: '/bill', note: `${d.not_billed.count} deliveries · oldest ${d.not_billed.oldest_days} days` },
          { label: t('strip.overdue'), labelTone: 'amber', value: d.overdue.amount, href: '/collect', note: `${d.overdue.count} invoices · ${d.overdue.reminders_sent} reminders sent` },
          { label: t('strip.recovered'), labelTone: 'green', value: d.recovered.amount, note: `${d.recovered.invoices} invoices you would have missed · ${inr(d.recovered.last_month)} last month` },
        ]} />
      )}

      {replay > 0 && live.data && (
        <Card className="mt-5 p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <Link href="/case?id=RG-1042" className="font-semibold hover:underline">Case RG-1042 · PO-184 · Example Customer</Link>
            <span className={clsx('tag', live.data.journey.current === 'paid' ? 't-green' : live.data.approval ? 't-amber' : 't-grey')}>{live.data.journey.current === 'paid' ? 'Billed' : live.data.approval ? 'Waiting for you' : 'Working'}</span>
          </div>
          <Journey journey={live.data.journey} />
          <div className={clsx('mt-4 rounded px-3.5 py-2.5 text-[13px] transition-colors duration-500', live.data.journey.current === 'paid' ? 'bg-green-bg' : live.data.approval ? 'bg-amber-bg' : 'bg-paper')}>{live.data.headline} {live.data.recommendation}</div>
        </Card>
      )}

      <div className="mt-2 grid gap-x-8 lg:grid-cols-[minmax(0,1fr)_330px] xl:grid-cols-[minmax(0,1fr)_350px]">
        <section className="min-w-0">
          <div className="sect"><h2>{t('today.billThese')}</h2>
            {d && d.not_billed.count > d.to_bill.length && <Link href="/bill" className="more">{d.not_billed.count - d.to_bill.length} more · {inr(d.not_billed.amount - d.to_bill.reduce((s, r) => s + r.amount, 0))} <ArrowRight size={13} className="inline" /></Link>}
          </div>
          {!d ? <Skeleton lines={4} /> : (
            <>
              <div className="hidden sm:block">
                <DataTable columns={cols} rows={d.to_bill} rowKey={(r) => r.case_ref} onRowClick={(r) => router.push(`/case?id=${r.case_ref}`)} minWidth={720}
                  empty={<EmptyState title="Nothing to bill today." hint="Every delivery we can see has an invoice. New challans and voice notes are checked as they arrive." />} />
              </div>
              <div className="space-y-2.5 sm:hidden">
                {d.to_bill.length === 0 && <Card><EmptyState title="Nothing to bill today." /></Card>}
                {d.to_bill.map((r) => (
                  <Link key={r.case_ref} href={`/case?id=${r.case_ref}`} className="card flex items-start justify-between gap-3 p-4">
                    <div className="min-w-0"><div className="font-semibold">{r.customer.replace(' Pvt Ltd', '')} · {r.po_ref}</div><div className="text-[13px] text-ink-3">{r.headline.split('.')[0]} · {r.waiting_days} days</div></div>
                    <Money value={r.amount} className="font-semibold" />
                  </Link>
                ))}
              </div>
            </>
          )}
        </section>

        <aside className="min-w-0">
          <div className="sect"><h2>{t('today.waiting')}</h2>{d && <Link href="/approvals" className="more">{d.waiting.count}</Link>}</div>
          {!d ? <Skeleton lines={3} /> : d.approvals.length === 0 ? <Card><EmptyState title="Nothing waiting for you." hint="New invoices and reminders that need your OK show up here." /></Card> : (
            <Card>
              {d.approvals.slice(0, 3).map((c) => (
                <div key={c.id} className="border-b border-rule p-4 last:border-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="font-semibold">{c.kind === 'reminder' ? 'WhatsApp reminder' : `Invoice · ${c.po_ref}`}</div>
                    <Money value={c.kind === 'reminder' ? c.amount : c.amount} className="font-semibold" />
                  </div>
                  <div className="mb-3 mt-0.5 text-[12.5px] text-ink-3">{c.customer.replace(' Pvt Ltd', '')} · {c.kind === 'reminder' ? `${c.po_ref} · UPI link` : `+ GST ${inr(c.gst)} · ${approverLine(c)}`}</div>
                  <ApproveActions card={c} size="sm" showReject={false} onDone={q.reload} extra={<Link href={`/case?id=${c.case_ref}`} className="btn-ghost btn-sm">Open</Link>} />
                </div>
              ))}
              {d.approvals.length > 3 && <Link href="/approvals" className="block border-t border-rule px-4 py-2.5 text-[13px] text-ink-2 hover:text-ink">{d.waiting.count - 3} more waiting <ArrowRight size={13} className="inline" /></Link>}
            </Card>
          )}

          <div className="sect"><h2>{t('today.chase')}</h2><Link href="/collect" className="more">All <ArrowRight size={13} className="inline" /></Link></div>
          {!d ? <Skeleton lines={3} /> : d.to_chase.length === 0 ? <Card><EmptyState title="Nobody is late. Nice." /></Card> : (
            <Card>
              {d.to_chase.slice(0, 3).map((r) => (
                <Link key={r.invoice_number} href={`/customers?id=${r.customer_id}`} className="flex items-start justify-between gap-3 border-b border-rule px-4 py-3 last:border-0 hover:bg-[#FBF9F3]">
                  <div className="min-w-0"><div className="truncate">{r.customer}</div><div className="truncate text-[12.5px] text-ink-3">{r.invoice_number} · {r.note ?? (r.reminder.status === 'none' ? 'no reminder yet' : `reminder ${r.reminder.status}`)}</div></div>
                  <div className="text-right"><Money value={r.amount} className="font-semibold" /><div className={clsx('text-[12.5px]', r.days_late > 30 ? 'text-red' : r.days_late > 14 ? 'text-amber' : 'text-ink-3')}>{r.days_late} days</div></div>
                </Link>
              ))}
            </Card>
          )}
        </aside>
      </div>

      {/* lower part: money flow + leaks + live feed (mockup 7) */}
      <Card className="mt-8 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-3.5 sm:px-6">
          <div><span className="font-semibold">{t('today.flow')}</span><span className="text-[13px] text-ink-3"> · {period === 'month' ? 'orders this month' : period === '30d' ? 'last 30 days' : 'this quarter'}</span></div>
          <div className="flex gap-1.5">
            {(['month', '30d', 'quarter'] as const).map((p) => <button key={p} onClick={() => setPeriod(p)} className={clsx('pill py-1 text-[12.5px]', period === p && 'pill-on')}>{t(`period.${p}` as any)}</button>)}
          </div>
        </div>
        {!d ? <Skeleton className="m-6 h-[260px]" /> : (
          <>
            <div className="pb-4"><MoneyFlow flow={d.flow} notes={{ notBilled: `${d.not_billed.count} deliveries · click to bill`, unpaid: `${d.overdue.count} overdue · ${d.overdue.reminders_sent} reminders` }} /></div>
            <div className="border-t border-rule bg-[#F7F4EC] px-4 py-3 text-[13px] sm:px-6">
              <Link href="/bill" className="font-semibold text-red hover:underline">{inr(Math.max(0, d.flow.delivered - d.flow.billed))} is stuck between delivery and billing.</Link>{' '}
              <span className="text-ink-2">That&apos;s money you&apos;ve earned but haven&apos;t asked for. Click any red number to see the list.</span>
            </div>
          </>
        )}
      </Card>

      <div className="mt-2 grid gap-x-8 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="min-w-0">
          <div className="sect"><h2>{t('today.leakBy')}</h2><Link href="/customers" className="more">All customers <ArrowRight size={13} className="inline" /></Link></div>
          {!d ? <Skeleton lines={4} /> : (
            <DataTable rows={(d.leaks ?? []) as any[]} rowKey={(r: any) => r.customer_id} onRowClick={(r: any) => router.push(`/customers?id=${r.customer_id}`)} minWidth={560}
              empty={<EmptyState title="No leaks right now." />}
              columns={[
                { key: 'c', header: 'Customer', render: (r: any) => <span className="font-semibold">{r.customer}</span> },
                { key: 'd', header: 'Delivered', align: 'right', hideSm: true, render: (r: any) => <Money value={r.delivered} /> },
                { key: 'b', header: 'Billed', align: 'right', hideSm: true, render: (r: any) => <Money value={r.billed} /> },
                { key: 'p', header: 'Paid', align: 'right', hideSm: true, render: (r: any) => <Money value={r.paid} /> },
                { key: 'n', header: 'Not billed', align: 'right', render: (r: any) => <Money value={r.not_billed} tone="red" className="font-semibold" /> },
                { key: 'u', header: 'Overdue', align: 'right', render: (r: any) => <Money value={r.overdue} tone={r.overdue > 50000 ? 'red' : 'ink'} /> },
              ]} />
          )}
        </section>
        <section className="min-w-0">
          <div className="sect"><h2>{t('today.live')}</h2><LivePulse /></div>
          <LiveFeed lines={lines} max={10} />
          {demo && lines.length === 0 && <button className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink" onClick={startReplay}><RotateCcw size={12} />Play the PO-184 story to see it live</button>}
        </section>
      </div>
    </div>
  );
}
