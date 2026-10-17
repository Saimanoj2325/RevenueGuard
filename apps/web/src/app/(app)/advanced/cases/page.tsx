'use client';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { FolderSearch, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Empty, ErrorNote, PageHead, SeverityBar, Skeleton, StateChip } from '@/components/legacy/ui';
import { api } from '@/lib/api';
import { ago, human, inr } from '@/lib/format';
import { useLive, useNow } from '@/lib/hooks';
import { onWs } from '@/lib/store';
import { EXCEPTION_TYPES, SEVERITIES, type CaseState } from '@/lib/types';

const STATE_GROUPS: { key: string; label: string; states: CaseState[] }[] = [
  { key: 'all', label: 'All', states: [] },
  { key: 'active', label: 'Investigating', states: ['INTAKE', 'TRIAGED', 'WATCHING', 'EVIDENCE_READY', 'VALIDATED', 'INVESTIGATING', 'PROPOSED'] },
  { key: 'approval', label: 'Awaiting approval', states: ['AWAITING_APPROVAL'] },
  { key: 'exec', label: 'Executing', states: ['EXECUTING', 'VERIFYING'] },
  { key: 'side', label: 'Paused / escalated / blocked', states: ['PAUSED', 'ESCALATED', 'BLOCKED'] },
  { key: 'closed', label: 'Closed', states: ['CLOSED'] },
];

export default function CasesPage() {
  const [group, setGroup] = useState('all');
  const [sev, setSev] = useState<string[]>([]);
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => { const t = setTimeout(() => setDq(q), 250); return () => clearTimeout(t); }, [q]);
  const states = STATE_GROUPS.find((g) => g.key === group)!.states;
  const now = useNow();

  const { data, error, loading } = useLive(
    () => api.cases({ status: states.join(',') || undefined, severity: sev.join(',') || undefined, q: dq || undefined }),
    [group, sev.join(','), dq],
    (e) => e.type === 'case.updated',
  );

  // flash rows that changed via WS
  const [flash, setFlash] = useState<Record<string, number>>({});
  useEffect(() => onWs((e) => { if (e.type === 'case.updated') setFlash((f) => ({ ...f, [e.case_id]: Date.now() })); }), []);

  const rows = useMemo(() => (data ?? []).filter((c) => !type || c.exception_type === type), [data, type]);
  const counts = useMemo(() => {
    const all = data ?? [];
    return { total: all.length, exposure: all.filter((c) => c.state !== 'CLOSED').reduce((s, c) => s + (c.amount ?? 0), 0) };
  }, [data]);
  const first = useRef(true);
  useEffect(() => { if (data) first.current = false; }, [data]);

  return (
    <div>
      <PageHead kicker="docket" title="Cases">
        <div className="panel flex items-center gap-4 px-3 py-2">
          <div><div className="eyebrow">in view</div><div className="num text-lg text-ink">{rows.length}</div></div>
          <div className="h-8 w-px bg-rule" />
          <div><div className="eyebrow">open exposure</div><div className="num text-lg text-[#9A6A12]">{inr(counts.exposure)}</div></div>
        </div>
      </PageHead>

      {/* filters */}
      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="State filter">
          {STATE_GROUPS.map((g) => (
            <button key={g.key} role="tab" aria-selected={group === g.key} onClick={() => setGroup(g.key)}
              className={clsx('rounded-full border px-3 py-1 text-[12.5px] transition', group === g.key ? 'border-paper bg-paper text-ink' : 'border-rule text-ink-2 hover:border-ink-3 hover:text-ink')}>
              {g.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <input className="input pl-8" placeholder="Search case, customer, PO…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search cases" />
          </div>
          <div className="flex items-center gap-1" aria-label="Severity filter">
            {SEVERITIES.map((s) => {
              const on = sev.includes(s);
              return (
                <button key={s} onClick={() => setSev(on ? sev.filter((x) => x !== s) : [...sev, s])} aria-pressed={on}
                  className={clsx('chip transition', on ? 'border-white/60 text-ink' : 'border-rule text-ink-3 hover:text-ink-2')}>
                  <span className="h-2 w-2 rounded-[1px]" style={{ background: { low: '#1E5A3C', medium: '#9A6A12', high: '#B23A26', critical: '#B23A26' }[s] }} />{s}
                </button>
              );
            })}
          </div>
          <select className="input w-auto" value={type} onChange={(e) => setType(e.target.value)} aria-label="Exception type">
            <option value="">All exception types</option>
            {EXCEPTION_TYPES.map((t) => <option key={t} value={t}>{human(t)}</option>)}
          </select>
        </div>
      </div>

      <ErrorNote error={error} />

      {loading && !data ? (
        <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : rows.length === 0 ? (
        <Empty icon={<FolderSearch className="text-ink-3" />} title="No cases match" hint="Clear a filter, or run Scene 1 in the Demo control room to open RG-1042." />
      ) : (
        <div className="panel overflow-hidden">
          <div className="hidden grid-cols-[130px_minmax(150px,1.3fr)_minmax(110px,0.9fr)_minmax(200px,1.1fr)_170px_110px_80px] gap-3 border-b border-rule px-4 py-2 md:grid">
            {['Case', 'Customer', 'Exception', 'Severity (Laya)', 'State', 'Amount', 'Updated'].map((h) => <div key={h} className="eyebrow">{h}</div>)}
          </div>
          <ul>
            <AnimatePresence initial={false}>
              {rows.map((c) => (
                <motion.li key={c.id} layout initial={first.current ? false : { opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
                  <Link href={`/advanced/case?id=${encodeURIComponent(c.id)}`}
                    className={clsx('grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 border-b border-rule px-4 py-3 transition last:border-0 hover:bg-card md:grid-cols-[130px_minmax(150px,1.3fr)_minmax(110px,0.9fr)_minmax(200px,1.1fr)_170px_110px_80px] md:items-center',
                      flash[c.id] && now - flash[c.id] < 2000 && 'animate-flash')}
                    key={flash[c.id] ?? 0}>
                    <div className="min-w-0">
                      <div className="num text-[13.5px] font-medium text-ink">{c.id}</div>
                      <div className="num text-[11px] text-ink-3">{c.reference ?? '—'}</div>
                    </div>
                    <div className="min-w-0 text-right md:text-left">
                      <div className="truncate text-[13.5px] text-[#1A1A17]">{c.customer ?? '—'}</div>
                      <div className="truncate text-[11.5px] text-ink-3 md:block">{c.summary}</div>
                    </div>
                    <div className="text-[12.5px] capitalize text-ink-2">{human(c.exception_type)}</div>
                    <div className="col-span-2 md:col-span-1"><SeverityBar probs={c.severity_probs} severity={c.severity} /></div>
                    <div><StateChip state={c.state} pulse={!['CLOSED', 'ESCALATED', 'BLOCKED'].includes(c.state)} /></div>
                    <div className="num text-right text-[13.5px] text-ink md:text-left">{inr(c.amount)}</div>
                    <div className="num hidden text-[11.5px] text-ink-3 md:block">{ago(c.updated_at, now)}</div>
                  </Link>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </div>
      )}
    </div>
  );
}
