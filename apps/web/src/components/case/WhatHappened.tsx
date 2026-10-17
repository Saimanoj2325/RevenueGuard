'use client';
// CONTRACT_V3 §4: "What happened" timeline, the Timeline agent's decision box and the Chat memory card.
import clsx from 'clsx';
import { AlertTriangle, BadgeCheck, ChevronDown, FileImage, Mail, MessageSquare, Mic, Sheet } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { dateIN, inr, timeIN } from '@/lib/format';
import { asList, badgesFor, billAmounts, counts, hasDecision, memoryCases, plainCheck, roleLabel, sortTimeline, statusOf } from '@/lib/timeline';
import type { ChatMemory, GstPreview, TimelineDecisionSummary, TimelineEvent } from '@/lib/v2types';

const TAG: Record<string, string> = { red: 't-red', amber: 't-amber', green: 't-green', grey: 't-grey' };
const ICON = (kind?: string | null) => {
  const k = (kind ?? '').toLowerCase();
  if (/photo|image|media/.test(k)) return FileImage;
  if (/voice|audio/.test(k)) return Mic;
  if (/email|mail/.test(k)) return Mail;
  if (/sheet|row/.test(k)) return Sheet;
  return MessageSquare;
};
const when = (at?: string | null) => (at ? `${dateIN(at, false)}, ${timeIN(at)}` : null);

/** Amount to bill: GST-inclusive figure on top, pre-GST below. */
export function GstAmount({ pre, total, className }: { pre: number; total: number; className?: string }) {
  return (
    <span className={clsx('inline-flex flex-col items-end leading-tight', className)}>
      <span className="num whitespace-nowrap font-semibold">{inr(total)}</span>
      <span className="num whitespace-nowrap text-[11.5px] font-normal text-ink-3">{inr(pre)} before GST</span>
    </span>
  );
}

export function TimelineRow({ e, defaultOpen = false }: { e: TimelineEvent; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const s = statusOf(e);
  const gone = s === 'deleted' || s === 'duplicate';
  const Icon = ICON(e.kind);
  const badges = badgesFor(e);
  const role = roleLabel(e.role);
  const versions = e.versions ?? [];
  const meta = [e.source_label, when(e.at), e.challan_number ? `Challan ${e.challan_number}` : null].filter(Boolean).join(' · ');
  return (
    <li className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 border-b border-rule px-4 py-3.5 last:border-0 sm:px-5" data-node={e.node_id} data-status={s}>
      <Icon size={16} strokeWidth={1.8} className={clsx('mt-0.5', gone ? 'text-ink-3' : 'text-ink-2')} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className={clsx('min-w-0 text-[14px] leading-snug', gone && 'text-ink-3', s === 'deleted' && 'strike')}>{e.text ? `"${e.text}"` : '(no text)'}</div>
          {e.qty != null && <span className={clsx('num whitespace-nowrap text-[13.5px] font-semibold', !counts(e) && 'text-ink-3', !counts(e) && gone && 'strike')}>{e.qty} nos</span>}
        </div>
        {meta && <div className="mt-0.5 text-[12.5px] text-ink-3">{meta}</div>}
        {(badges.length > 0 || role) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {badges.map((b) => b.key === 'edited' && versions.length ? (
              <button key={b.key} type="button" className={clsx('tag inline-flex items-center gap-1', TAG[b.tone])} onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Show old versions">
                {b.label}<ChevronDown size={11} className={clsx('transition-transform', open && 'rotate-180')} />
              </button>
            ) : (
              <span key={b.key} className={clsx('tag', TAG[b.tone])}>{b.label}{b.note ? <span className="font-normal"> · {b.note}</span> : null}</span>
            ))}
            {role && !(gone && role.tone === 'grey') && <span className={clsx('tag', TAG[role.tone])}>{role.label}</span>}
          </div>
        )}
        {open && versions.length > 0 && (
          <ul className="mt-2 space-y-1 rounded border border-rule bg-paper px-3 py-2 text-[12.5px]" aria-label="Old versions">
            {versions.map((v, i) => (
              <li key={i} className="text-ink-2"><span className="strike">&quot;{v.text}&quot;</span>{v.at ? <span className="text-ink-3"> · {when(v.at)}</span> : null}</li>
            ))}
            <li className="text-ink-3">Now: &quot;{e.text}&quot;</li>
          </ul>
        )}
        {e.why && <div className="mt-1.5 text-[12.5px] text-ink-2"><span className="text-ink-3">Why: </span>{e.why}</div>}
      </div>
    </li>
  );
}

export function WhatHappened({ timeline }: { timeline?: TimelineEvent[] | null }) {
  const rows = sortTimeline(timeline);
  if (!rows.length) return null;
  const total = rows.filter(counts).reduce((s, e) => s + (e.qty ?? 0), 0);
  const skipped = rows.filter((e) => ['deleted', 'duplicate'].includes(statusOf(e))).length;
  return (
    <section>
      <div className="sect"><h2>What happened</h2><span className="text-[13px] text-ink-2">{rows.length} messages{skipped ? ` · ${skipped} not counted` : ''}{total ? ` · ${total} counted` : ''}</span></div>
      <ol className="card p-0">{rows.map((e) => <TimelineRow key={e.node_id} e={e} />)}</ol>
    </section>
  );
}

export function AgentDecision({ d, preview, rate }: { d?: TimelineDecisionSummary | null; preview?: GstPreview | null; rate?: number | null }) {
  if (!hasDecision(d)) return null;
  const failed = (d.failed_checks ?? []).filter(Boolean);
  const ok = d.verified === true && failed.length === 0;
  const money = d.delivered_total ? billAmounts({ preview, qty: d.delivered_total, rate }) : null;
  return (
    <div className={clsx('card mt-4 border-l-[3px] p-4 sm:p-5', ok ? 'border-l-green' : failed.length || d.verified === false ? 'border-l-amber' : 'border-l-rule-2')} data-testid="agent-decision">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">How we read the chat</div>
          {d.explanation_for_owner && <p className="mt-1 text-[15px] leading-snug">{d.explanation_for_owner}</p>}
          <div className="mt-2">
            {ok ? (
              <span className="inline-flex items-center gap-1 text-[13px] text-green"><BadgeCheck size={14} />Verified · every number checked against the messages</span>
            ) : failed.length || d.verified === false ? (
              <div className="text-[13px] text-amber">
                <span className="inline-flex items-center gap-1 font-semibold"><AlertTriangle size={14} />Needs a check</span>
                {failed.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">{failed.map((c, i) => <li key={i}>{plainCheck(c)}</li>)}</ul>}
              </div>
            ) : <span className="text-[13px] text-ink-3">Checking…</span>}
          </div>
        </div>
        {d.delivered_total != null && (
          <div className="text-right">
            <div className="text-[12.5px] text-ink-3">Delivered</div>
            <div className="serif text-[26px] leading-none">{d.delivered_total}</div>
            {money && ok && <div className="mt-1.5 text-[13px]"><div className="text-[11.5px] text-ink-3">To bill (with GST)</div><GstAmount pre={money.pre} total={money.total} /></div>}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatMemoryCard({ m, caseRef }: { m?: ChatMemory | null; caseRef?: string }) {
  if (!m) return null;
  const questions = asList(m.open_questions);
  const pending = asList(m.pending);
  const others = memoryCases(m, caseRef);
  if (!m.summary && !m.active_po && !questions.length && !pending.length && !others.length) return null;
  return (
    <div className="card mt-4 p-5 text-[13.5px]" data-testid="chat-memory">
      <div className="mb-2 flex items-baseline justify-between gap-2"><b className="text-[15px]">Chat memory</b><span className="truncate text-[12.5px] text-ink-3">{m.label ?? m.chat_key ?? ''}</span></div>
      {m.active_po && <div className="mb-2"><span className="text-ink-3">Talking about now: </span><b>{m.active_po}</b></div>}
      {m.summary && <p className="text-ink-2">{m.summary}</p>}
      {questions.length > 0 && (
        <div className="mt-3"><div className="text-[12.5px] font-semibold text-amber">Open questions</div><ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-ink-2">{questions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>
      )}
      {pending.length > 0 && (
        <div className="mt-3"><div className="text-[12.5px] font-semibold text-ink-3">Still pending</div><ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-ink-2">{pending.map((q, i) => <li key={i}>{q}</li>)}</ul></div>
      )}
      {others.length > 0 && (
        <div className="mt-3"><div className="text-[12.5px] font-semibold text-ink-3">Other cases in this chat</div>
          <ul className="mt-1 space-y-1">{others.map((c, i) => (
            <li key={c.case_ref ?? c.po_ref ?? i} className="flex flex-wrap gap-x-2">
              {c.case_ref ? <Link href={`/case?id=${encodeURIComponent(c.case_ref)}`} className="mono underline decoration-rule-2 underline-offset-2 hover:text-ink">{c.case_ref}</Link> : null}
              <span className="text-ink-2">{[c.po_ref, c.customer, c.label].filter(Boolean).join(' · ')}</span>
            </li>
          ))}</ul>
        </div>
      )}
      <p className="mt-3 text-[12px] text-ink-3">What we remember from this chat, so the next message is linked to the right order.</p>
    </div>
  );
}
