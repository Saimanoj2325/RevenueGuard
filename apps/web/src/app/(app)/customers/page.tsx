'use client';
import clsx from 'clsx';
import { ArrowRight, Printer, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { ApproveActions } from '@/components/money/ApproveActions';
import { RiskTag } from '@/components/money/tags';
import { Card, DataTable, EmptyState, ErrorState, Money, PageHead, Skeleton, StatStrip, StatusTag } from '@/components/ui';
import { api } from '@/lib/api';
import { dayMonth, inr } from '@/lib/format';
import { useLive } from '@/lib/hooks';
import { useT } from '@/i18n';
import type { ApprovalCard, CustomerDetail, CustomerRow } from '@/lib/v2types';

const refresh = (e: { type: string }) => ['case.updated', 'approval.updated'].includes(e.type);

function PayDays({ c }: { c: CustomerRow }) {
  const late = c.avg_days_to_pay - c.terms_days;
  const max = 60;
  return (
    <div className="min-w-[140px]">
      <div className="num text-[13.5px]"><span className={clsx(late > 15 ? 'text-red' : late > 0 ? 'text-amber' : 'text-ink')}>{c.avg_days_to_pay} days</span> <span className="text-ink-3">/ {c.terms_days}</span></div>
      <div className="relative mt-1 h-[4px] w-full bg-rule">
        <span className={clsx('absolute inset-y-0 left-0', late > 15 ? 'bg-red' : late > 0 ? 'bg-amber' : 'bg-green')} style={{ width: `${Math.min(100, (c.avg_days_to_pay / max) * 100)}%` }} />
        <span className="absolute -top-[3px] h-[10px] w-[2px] bg-ink" style={{ left: `${(c.terms_days / max) * 100}%` }} title={`Terms: ${c.terms_days} days`} />
      </div>
    </div>
  );
}

function List() {
  const t = useT();
  const router = useRouter();
  const q = useLive(() => api.customers(), [], refresh, 400);
  const [s, setS] = useState('');
  const [risk, setRisk] = useState<'all' | 'good' | 'watch' | 'high'>('all');
  const rows = useMemo(() => (q.data ?? []).filter((c) => (risk === 'all' || c.risk === risk) && `${c.name} ${c.city} ${c.gstin}`.toLowerCase().includes(s.toLowerCase())), [q.data, s, risk]);
  const all = q.data ?? [];
  return (
    <div>
      <PageHead title={t('customers.title')} sub={t('customers.sub')} />
      {q.error && !q.data ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <Skeleton className="h-[110px]" /> : (
        <StatStrip size={30} stats={[
          { label: 'Owed to you', labelTone: 'ink', value: all.reduce((x, c) => x + c.outstanding, 0), note: `${all.filter((c) => c.outstanding > 0).length} customers · billed + not billed` },
          { label: 'Overdue', labelTone: 'red', value: all.reduce((x, c) => x + c.overdue, 0), note: `${all.filter((c) => c.overdue > 0).length} customers late` },
          { label: 'Not billed yet', labelTone: 'red', value: all.reduce((x, c) => x + (c.not_billed ?? 0), 0), note: 'delivered, no invoice' },
          { label: 'High risk', labelTone: 'amber', text: String(all.filter((c) => c.risk === 'high').length), note: 'over 15 days late or 3 reminders ignored' },
        ]} />
      )}
      <div className="mb-3 mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">{(['all', 'good', 'watch', 'high'] as const).map((r) => <button key={r} className={clsx('pill', risk === r && 'pill-on')} onClick={() => setRisk(r)}>{r === 'all' ? 'All' : t(`st.${r}` as any)} {all.filter((c) => r === 'all' || c.risk === r).length}</button>)}</div>
        <label className="flex w-full max-w-[280px] items-center gap-2 rounded border border-rule-2 bg-card px-3 py-1.5 text-ink-3"><Search size={14} /><input className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink focus:outline-none" placeholder="Find a customer or GSTIN" value={s} onChange={(e) => setS(e.target.value)} /></label>
      </div>
      {!q.data ? <Skeleton lines={6} /> : (
        <DataTable rows={rows} rowKey={(c) => c.id} onRowClick={(c) => router.push(`/customers?id=${encodeURIComponent(c.id)}`)} minWidth={820}
          empty={<EmptyState title="No customers match." hint="Customers come from Zoho Books and your POs automatically." />}
          columns={[
            { key: 'n', header: 'Customer', render: (c) => <div><div className="font-semibold">{c.name}</div><div className="text-[12px] text-ink-3">{c.city} · <span className="mono">{c.gstin}</span></div></div> },
            { key: 'o', header: 'Outstanding', align: 'right', render: (c) => <Money value={c.outstanding} className="font-semibold" /> },
            { key: 'nb', header: 'Not billed', align: 'right', render: (c) => <Money value={c.not_billed ?? 0} tone={(c.not_billed ?? 0) > 0 ? 'red' : 'muted'} /> },
            { key: 'od', header: 'Overdue', align: 'right', render: (c) => <Money value={c.overdue} tone={c.overdue > 0 ? 'red' : 'muted'} /> },
            { key: 'd', header: 'Days to pay vs terms', render: (c) => <PayDays c={c} /> },
            { key: 'r', header: 'Risk', render: (c) => <RiskTag risk={c.risk} reason={c.risk_reason} /> },
          ]} />
      )}
      <p className="mt-3 text-[12.5px] text-ink-3">Risk rule (hover a tag for the reason): Good = pays within terms · Watch = 1 to 15 days late on average · High = over 15 days late or 3 reminders ignored. Based on the last 6 invoices.</p>
    </div>
  );
}

function OrderBar({ o }: { o: CustomerDetail['orders'][number] }) {
  const w = (n: number) => `${o.ordered ? Math.min(100, (n / o.ordered) * 100) : 0}%`;
  return (
    <div className="relative h-[8px] w-full min-w-[110px] bg-rule" title={`Ordered ${o.ordered} · delivered ${o.delivered} · billed ${o.billed} · paid ${o.paid}`}>
      <span className="absolute inset-y-0 left-0 bg-[#C9C2AE] transition-all duration-700" style={{ width: w(o.delivered) }} />
      <span className="absolute inset-y-0 left-0 bg-ink-2 transition-all duration-700" style={{ width: w(o.billed) }} />
      <span className="absolute inset-y-0 left-0 bg-green transition-all duration-700" style={{ width: w(o.paid) }} />
    </div>
  );
}
const statusTone = (s?: string) => (!s ? 'grey' : s.startsWith('Closed') ? 'green' : s.startsWith('Overdue') || s.startsWith('Bill') ? 'red' : s.startsWith('Awaiting') ? 'amber' : 'grey') as any;

function Detail({ id }: { id: string }) {
  const router = useRouter();
  const q = useLive(() => api.customer(id), [id], refresh, 300);
  const cards = useLive(() => api.approvalCards('pending'), [], refresh, 300);
  const [sending, setSending] = useState<string | null>(null);
  const d = q.data;
  if (q.error && !d) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!d) return <div className="space-y-4"><Skeleton className="h-10 w-80" /><Skeleton className="h-[110px]" /><Skeleton lines={5} /></div>;
  const c = d.customer;
  const draft = d.followups.find((f) => f.approval_id);
  const draftCard: ApprovalCard | undefined = draft ? (cards.data ?? []).find((x) => x.id === draft.approval_id) : undefined;
  const firstOverdue = d.orders.find((o) => o.status?.startsWith('Overdue'));
  async function remind() {
    setSending(null);
    try {
      const col = await api.collect('all');
      const inv = col.items.find((r) => r.customer_id === c.id);
      if (!inv) { setSending('Nothing overdue for this customer.'); return; }
      await api.draftReminder(inv.invoice_number, inv.days_late >= 30 ? 30 : inv.days_late >= 15 ? 15 : 7);
      setSending('Reminder drafted. It waits for approval below.');
      q.reload(); cards.reload();
    } catch (e: any) { setSending(e?.message ?? 'Could not draft it.'); }
  }
  return (
    <div>
      <div className="mb-2 text-[13px] text-ink-3"><Link href="/customers" className="hover:text-ink">Customers</Link> › {c.name}</div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] sm:text-[30px]">{c.name}</h1>
          <div className="mt-1 text-[13.5px] text-ink-3">{c.city} · <span className="mono text-[12.5px]">GSTIN {c.gstin}</span> · Accounts: {c.contact_name}, {c.contact_masked}{c.since ? ` · customer since ${c.since}` : ''}</div>
        </div>
        <div className="flex gap-2 print:hidden">
          <button className="btn-ghost" onClick={() => window.print()}><Printer size={14} />Statement PDF</button>
          <button className="btn" onClick={remind} disabled={!!draft}>{draft ? 'Reminder drafted' : 'Send reminder'}</button>
        </div>
      </div>
      {sending && <div className="mb-3 text-[13px] text-ink-2">{sending}</div>}
      <StatStrip size={32} stats={[
        { label: 'Not billed yet', caps: false, value: d.stats.not_billed, note: d.stats.not_billed_note },
        { label: 'Overdue', caps: false, value: d.stats.overdue, tone: d.stats.overdue ? 'red' : 'ink', note: d.stats.overdue_note },
        { label: 'Usually pays in', caps: false, text: `${d.stats.avg_days_to_pay} days`, note: `terms are ${d.stats.terms_days} · last 6 invoices` },
        { label: 'Payment risk', caps: false, text: <span className="font-sans text-[26px] font-semibold">{d.stats.risk === 'good' ? 'Good' : d.stats.risk === 'watch' ? 'Watch' : 'High'}</span>, tone: d.stats.risk === 'good' ? 'green' : d.stats.risk === 'watch' ? 'amber' : 'red', note: d.stats.risk_reason.replace(/\s*\(.*\)$/, '') },
      ]} />

      <div className="mt-2 grid gap-x-8 xl:grid-cols-[minmax(0,1fr)_400px]">
        <section className="min-w-0">
          <div className="sect"><h2>Orders</h2>
            <span className="flex gap-3 text-[12.5px] text-ink-2"><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-[#C9C2AE]" />Delivered</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-ink-2" />Billed</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-green" />Paid</span></span>
          </div>
          <DataTable rows={d.orders} rowKey={(o) => o.po_ref} minWidth={680} empty={<EmptyState title="No orders yet." />}
            onRowClick={(o) => { if (o.case_ref) router.push(`/case?id=${o.case_ref}`); }}
            columns={[
              { key: 'po', header: 'PO', render: (o) => <div><div className="font-semibold">{o.po_ref}</div><div className="text-[12px] text-ink-3">{dayMonth(o.date)}</div></div> },
              { key: 'i', header: 'Item', hideSm: true, render: (o) => o.item },
              { key: 'q', header: 'Ord · Del · Bill · Paid', render: (o) => <span className="num whitespace-nowrap">{o.ordered} · {o.delivered} · {o.billed} · {o.paid}</span> },
              { key: 'b', header: '', hideSm: true, render: (o) => <OrderBar o={o} /> },
              { key: 'v', header: 'Value', align: 'right', render: (o) => <Money value={o.amount} /> },
              { key: 's', header: 'Status', render: (o) => <StatusTag tone={statusTone(o.status)}>{o.status}</StatusTag> },
            ]} />
        </section>
        <aside className="min-w-0">
          <div className="sect"><h2>Payment follow-ups</h2><span className="mono text-[12.5px] text-ink-3">{firstOverdue ? d.stats.overdue_note?.split(' · ')[0] : ''}</span></div>
          <Card className="px-4 sm:px-5">
            {d.followups.length === 0 && <EmptyState title="No follow-ups needed." hint="This customer has nothing overdue." />}
            {d.followups.map((f, i) => (
              <div key={i} className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 border-b border-rule py-3.5 last:border-0">
                <div className={clsx('text-[12.5px]', f.status === 'draft' ? 'font-medium text-amber' : 'text-ink-3')}>{dayMonth(f.at)}</div>
                <div className="min-w-0">
                  <div className="text-[13.5px]"><b>{f.kind.split(' · ')[0]}</b>{f.kind.includes(' · ') ? ' · ' + f.kind.split(' · ').slice(1).join(' · ') : ''}</div>
                  <div className="text-[12.5px] text-ink-3">{f.text}</div>
                  {f.draft && <blockquote className="mt-2 whitespace-pre-line border-l-2 border-rule-2 bg-paper px-3 py-2 text-[13px] text-ink-2">{f.draft.replace(/(upi:\/\/pay\?pa=[^&]+)\S*/, '$1…')}</blockquote>}
                  {f.approval_id && draftCard && <div className="mt-3"><ApproveActions card={draftCard} size="sm" onDone={() => { q.reload(); cards.reload(); }} extra={<Link href="/collect" className="btn-ghost btn-sm">Edit <ArrowRight size={12} /></Link>} /></div>}
                </div>
              </div>
            ))}
          </Card>
          <p className="mt-3 text-[12.5px] text-ink-3">Not billed and overdue total {inr(d.stats.not_billed + d.stats.overdue)}. Statement PDF prints this page.</p>
        </aside>
      </div>
    </div>
  );
}

function Inner() {
  const id = useSearchParams().get('id');
  return id ? <Detail id={id} key={id} /> : <List />;
}
export default function CustomersPage() { return <Suspense fallback={<Skeleton className="h-40" />}><Inner /></Suspense>; }
