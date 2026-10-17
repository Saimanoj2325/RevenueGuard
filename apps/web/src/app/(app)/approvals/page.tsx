'use client';
import clsx from 'clsx';
import { Clock, Lock } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ApproveActions } from '@/components/money/ApproveActions';
import { Card, EmptyState, ErrorState, PageHead, ProofList, Skeleton, StatusTag } from '@/components/ui';
import { MoneyFigure } from '@/components/ui/Money';
import { api } from '@/lib/api';
import { inr, timeIN, whenIN } from '@/lib/format';
import { useLive } from '@/lib/hooks';
import { useT } from '@/i18n';
import type { ApprovalCard } from '@/lib/v2types';

type Tab = 'waiting' | 'expired' | 'approved' | 'rejected';
const statusTab = (s?: string): Tab => (s === 'pending' || s === 'partially_approved' ? 'waiting' : s === 'expired' ? 'expired' : s === 'rejected' ? 'rejected' : 'approved');

function Who({ c }: { c: ApprovalCard }) {
  if (c.approvals.length && c.approvers_needed > c.approvals.length) {
    return <div className="text-[13px]"><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-green" />{c.approvals.map((a) => `${a.user} approved ${a.at ? timeIN(a.at) : ''}`).join(', ')} <span className="text-ink-3">· {c.approvers_needed - c.approvals.length} more needed</span></div>;
  }
  return <div className="text-[13px] text-ink-2">Needs {c.approvers_needed} approver{c.approvers_needed > 1 ? 's' : ''} · {c.kind === 'reminder' ? 'customer message' : 'Finance'}</div>;
}

function Row({ c, onDone }: { c: ApprovalCard; onDone: () => void }) {
  const waiting = statusTab(c.status) === 'waiting';
  return (
    <Card className="p-4 sm:p-5">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center md:gap-8">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <StatusTag tone={c.kind === 'reminder' ? 'amber' : 'red'}>{c.kind === 'reminder' ? 'Reminder' : 'Invoice'}</StatusTag>
            <Link href={`/case?id=${c.case_ref}`} className="font-semibold hover:underline">{c.customer.replace(' Pvt Ltd', '')} · {c.po_ref}</Link>
          </div>
          <div className="mt-1.5 text-[13.5px] text-ink-2">{c.what}{c.created_at ? ` · ${whenIN(c.created_at)}` : ''}</div>
          <div className="mt-2.5"><ProofList proofs={c.proofs} caseRef={c.kind === 'reminder' ? null : c.case_ref} short /></div>
        </div>
        <div className="md:text-right">
          <MoneyFigure value={c.amount} size={32} />
          <div className="mt-1 text-[12.5px] text-ink-3">{c.kind === 'reminder' ? 'customer message' : `+ GST = ${inr(c.total)}`}</div>
        </div>
        <div className="md:w-[290px]">
          {waiting ? (
            <>
              <div className="mb-2"><Who c={c} /></div>
              <ApproveActions card={c} onDone={onDone} extra={<Link href={`/case?id=${c.case_ref}`} className="btn-ghost">Open</Link>} />
            </>
          ) : (
            <div className="text-[13px] text-ink-2">
              <StatusTag tone={c.status === 'approved' ? 'green' : c.status === 'rejected' ? 'red' : 'grey'}>{c.status === 'approved' ? 'Approved' : c.status === 'rejected' ? 'Rejected' : 'Expired'}</StatusTag>
              {c.approvals.length > 0 && <div className="mt-1.5">{c.approvals.map((a) => `${a.user} ${a.at ? timeIN(a.at) : ''}`).join(' · ')}</div>}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Phone layout (mockup 3): one big card per approval, thumb-sized buttons. */
function PhoneCard({ c, onDone }: { c: ApprovalCard; onDone: () => void }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between"><StatusTag tone={c.kind === 'reminder' ? 'amber' : 'red'}>{c.kind === 'reminder' ? 'Payment reminder' : 'New invoice'}</StatusTag><span className="text-[12px] text-ink-3">{c.created_at ? whenIN(c.created_at) : ''}</span></div>
      <div className="mt-3 font-semibold">{c.customer}</div>
      <div className="text-[13px] text-ink-3">{c.po_ref}</div>
      <div className="mt-3"><MoneyFigure value={c.kind === 'reminder' ? c.amount : c.total} size={38} /></div>
      <div className="mt-1 text-[13px] text-ink-2">{c.kind === 'reminder' ? 'Reminder with UPI link' : `${inr(c.amount)} + GST ${inr(c.gst)}`}</div>
      <div className="mt-2 text-[13.5px]">{c.what}</div>
      <div className="mt-3"><ProofList proofs={c.proofs} caseRef={c.kind === 'reminder' ? null : c.case_ref} /></div>
      <div className="mt-3 rounded bg-paper px-3 py-2"><Who c={c} />{c.approvers_needed > 1 && <div className="mt-1 flex gap-1">{Array.from({ length: c.approvers_needed }).map((_, i) => <span key={i} className={clsx('h-1 flex-1', i < c.approvals.length ? 'bg-green' : 'bg-rule-2')} />)}</div>}</div>
      <div className="mt-4"><ApproveActions card={c} onDone={onDone} full /></div>
      <Link href={`/case?id=${c.case_ref}`} className="mt-3 block text-center text-[13px] text-ink-2 underline-offset-2 hover:underline">See all proof</Link>
    </Card>
  );
}

export default function ApprovalsPage() {
  const t = useT();
  const [tab, setTab] = useState<Tab>('waiting');
  const q = useLive(() => api.approvalCards(), [], (e) => e.type === 'approval.updated' || e.type === 'case.updated', 250);
  const all = q.data ?? [];
  const by = (k: Tab) => all.filter((c) => statusTab(c.status) === k);
  const rows = by(tab);
  const expired = by('expired');
  return (
    <div>
      <PageHead title={t('approvals.title')} sub={t('approvals.sub')} />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {(['waiting', 'expired', 'approved', 'rejected'] as Tab[]).map((k) => <button key={k} className={clsx('pill', tab === k && 'pill-on')} onClick={() => setTab(k)}>{k === 'waiting' ? 'Waiting' : k === 'expired' ? 'Expired' : k === 'approved' ? 'Approved' : 'Rejected'} {by(k).length}</button>)}
      </div>
      {q.error && !q.data && <ErrorState error={q.error} onRetry={q.reload} />}
      {!q.data && !q.error && <Skeleton lines={4} />}
      {q.data && rows.length === 0 && <Card><EmptyState title={tab === 'waiting' ? 'Nothing waiting for you.' : 'Nothing here.'} hint={tab === 'waiting' ? 'When an invoice or a reminder needs a yes, it shows up here and on WhatsApp.' : undefined} /></Card>}
      {q.data && rows.length > 0 && (
        <>
          <div className="hidden space-y-3 sm:block">{rows.map((c) => <Row key={c.id} c={c} onDone={q.reload} />)}</div>
          <div className="space-y-3 sm:hidden">{rows.map((c) => <PhoneCard key={c.id} c={c} onDone={q.reload} />)}</div>
        </>
      )}
      {tab === 'waiting' && expired.slice(0, 2).map((c) => (
        <div key={c.id} className="mt-3 flex items-start gap-3 rounded-md border border-dashed border-rule-2 px-4 py-3.5 sm:px-5">
          <Clock size={17} strokeWidth={1.8} className="mt-0.5 shrink-0 text-amber" />
          <div className="min-w-0 flex-1"><div className="font-semibold">Expired: {c.kind === 'reminder' ? 'Reminder' : 'Invoice'} {c.po_ref} for <span className="strike">{inr(c.amount)}</span></div><div className="text-[13px] text-ink-2">{c.expires_reason}</div></div>
          <StatusTag>Expired</StatusTag>
        </div>
      ))}
      <p className="mt-4 flex items-start gap-1.5 text-[12.5px] text-ink-3"><Lock size={13} className="mt-0.5 shrink-0" />Each approval is locked to the exact amount and proof you saw. If anything changes, it expires and asks again. Over ₹1 lakh needs two different people.</p>
    </div>
  );
}
