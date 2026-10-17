'use client';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { human, inr } from '@/lib/format';
import { useLive } from '@/lib/hooks';
import { onWs } from '@/lib/store';
import type { AgentEvent, CaseDetail } from '@/lib/types';
import { CopyText, ErrorNote, SeverityBar, Skeleton, StateChip, Stamp } from '@/components/legacy/ui';
import { ApprovalPanel, AuditTrail, ExecutionPanel, FactsPanel, LayaPanel, ProposalPanel } from './Decision';
import { EvidenceBoard } from './EvidenceBoard';
import { AgentLanes, Checkpoints, StateMachine } from './Orchestration';
import { TimelineSpine } from './TimelineSpine';

const TABS = [
  { k: 'board', label: 'Evidence board' },
  { k: 'orch', label: 'Orchestration' },
  { k: 'decision', label: 'Proposal & approval' },
  { k: 'exec', label: 'Execution & verifier' },
  { k: 'audit', label: 'Audit trail' },
] as const;
type Tab = (typeof TABS)[number]['k'];

export function CaseHeader({ d, compact }: { d: CaseDetail; compact?: boolean }) {
  const c = d.case;
  return (
    <div className={clsx('paper relative overflow-hidden', compact ? 'px-4 py-3' : 'px-5 py-4 sm:px-6')}>
      {/* folder tab */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="eyebrow">case file · {human(c.exception_type)}</div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className={clsx('num font-semibold tracking-tight', compact ? 'text-[22px]' : 'text-[30px] sm:text-[36px]')}>{c.id}</h1>
            <span className={clsx('serif truncate', compact ? 'text-[15px]' : 'text-[19px]')}>{c.customer ?? 'Unattributed'}</span>
            {c.reference && <span className="num text-[13px] text-ink-3">{c.reference}</span>}
          </div>
          {!compact && c.summary && <p className="mt-1 max-w-2xl text-[13px] text-ink-3">{c.summary}</p>}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="num text-[24px] font-semibold leading-none sm:text-[28px]">{inr(c.amount)}</div>
          <div className="eyebrow">order value</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-dashed border-rule pt-2.5">
        <span className="rounded-full bg-paper px-0.5 py-0.5"><StateChip state={c.state} pulse={!['CLOSED', 'ESCALATED', 'BLOCKED'].includes(c.state)} /></span>
        <div className="w-[200px]"><SeverityBar probs={c.severity_probs ?? d.laya?.answers.severity?.probs} severity={c.severity} onPaper /></div>
        <span className="num text-[11px] text-ink-3">evidence v{c.evidence_version ?? 0}</span>
        {c.correlation_id && (
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-ink-3">
            <span className="eyebrow">corr</span><CopyText text={c.correlation_id} className="max-w-[220px] text-[11px] text-ink" />
          </span>
        )}
        {c.state === 'CLOSED' && <Stamp color="#1E5A3C" className="ml-auto">closed · verified</Stamp>}
      </div>
    </div>
  );
}

export function CaseFile({ id }: { id: string }) {
  const [tab, setTab] = useState<Tab>('board');
  const { data: d, error, reload } = useLive(
    () => api.case(id),
    [id],
    (e) => ('case_id' in e && e.case_id === id) || (e.type === 'approval.updated' && e.approval.case_id === id),
    150,
  );
  const traceQ = useLive(() => api.trace(id), [id]);
  const auditQ = useLive(() => api.audit({ case_id: id }), [id], (e) => ('case_id' in e && e.case_id === id) || e.type === 'approval.updated', 300);

  // live append of agent events
  const [live, setLive] = useState<AgentEvent[]>([]);
  useEffect(() => { setLive([]); }, [id, traceQ.data]);
  useEffect(() => onWs((e) => {
    if (e.type === 'agent.event' && e.case_id === id) setLive((l) => [...l, e.event]);
  }), [id]);
  const trace = useMemo(() => {
    const base = traceQ.data ?? [];
    const key = (x: AgentEvent) => `${x.run_id}|${x.type}|${x.ts}|${x.data?.step ?? ''}`;
    const seen = new Set(base.map(key));
    return [...base, ...live.filter((x) => !seen.has(key(x)))];
  }, [traceQ.data, live]);

  if (error && !d) return <div className="space-y-3"><BackLink /><ErrorNote error={error} /></div>;
  if (!d) return <div className="space-y-3"><BackLink /><Skeleton className="h-32" /><Skeleton className="h-24" /><Skeleton className="h-[520px]" /></div>;

  return (
    <div className="space-y-4">
      <BackLink />
      <CaseHeader d={d} />
      <TimelineSpine timeline={d.timeline} />

      <div className="sticky top-14 z-10 -mx-3 overflow-x-auto bg-paper px-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex gap-1 border-b border-rule" role="tablist">
          {TABS.map((t) => (
            <button key={t.k} role="tab" aria-selected={tab === t.k} onClick={() => setTab(t.k)}
              className={clsx('relative whitespace-nowrap px-3 py-2.5 text-[13px] transition', tab === t.k ? 'text-ink' : 'text-ink-3 hover:text-ink-2')}>
              {t.label}
              {t.k === 'decision' && d.approvals.some((a) => a.status === 'pending' || a.status === 'partially_approved') && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[#9A6A12] align-middle" />}
              {tab === t.k && <motion.span layoutId="casetab" className="absolute inset-x-2 -bottom-px h-[2px] bg-red" />}
            </button>
          ))}
        </div>
      </div>

      {tab === 'board' && (
        <div className="space-y-4">
          <EvidenceBoard detail={d} height={760} />
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
            <FactsPanel detail={d} />
            <ProposalPanel detail={d} compact />
          </div>
        </div>
      )}
      {tab === 'orch' && (
        <div className="space-y-4">
          <StateMachine detail={d} />
          <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
            {traceQ.data ? <AgentLanes trace={trace} /> : <Skeleton className="h-[300px]" />}
            <Checkpoints detail={d} />
          </div>
        </div>
      )}
      {tab === 'decision' && (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="space-y-4"><ProposalPanel detail={d} /><FactsPanel detail={d} /></div>
          <div className="space-y-4">
            <ApprovalPanel detail={d} audit={auditQ.data ?? []} onChanged={() => { reload(); auditQ.reload(); }} />
            <LayaPanel detail={d} />
          </div>
        </div>
      )}
      {tab === 'exec' && <ExecutionPanel detail={d} />}
      {tab === 'audit' && <AuditTrail rows={auditQ.data ?? []} max={500} />}
    </div>
  );
}

function BackLink() {
  return <Link href="/advanced/cases" className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink"><ArrowLeft size={14} />All cases</Link>;
}
