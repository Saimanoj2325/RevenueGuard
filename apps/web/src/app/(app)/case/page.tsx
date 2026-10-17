'use client';
import clsx from 'clsx';
import { AlertTriangle, Check, ChevronDown, Clock, Loader2, Pencil, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ApproveActions } from '@/components/money/ApproveActions';
import { InvoicePreview } from '@/components/money/InvoicePreview';
import { AgentDecision, ChatMemoryCard, WhatHappened } from '@/components/case/WhatHappened';
import { Card, EmptyState, ErrorState, Journey, PROOF_ICON, Skeleton, StatusTag, plainError, useProofView } from '@/components/ui';
import { api } from '@/lib/api';
import { dateIN, inr, timeIN } from '@/lib/format';
import { useLive } from '@/lib/hooks';
import { useAuth } from '@/lib/store';
import { useT } from '@/i18n';
import type { CaseSummaryV2, Fact } from '@/lib/v2types';

// ids the live API returns (delivered_qty, order_qty, rate, customer) + the ids the demo backend uses
const CORRECTABLE = new Set(['delivered', 'challan', 'sheet', 'voice', 'delivered_qty', 'order_qty', 'rate', 'customer', 'po_ref']);
const FIX_ID: Record<string, string> = { delivered: 'delivered_qty', challan: 'delivered_qty', sheet: 'delivered_qty', voice: 'delivered_qty' };
const FIX_LABEL: Record<string, string> = { order_qty: 'Correct ordered quantity:', rate: 'Correct rate (₹):', customer: 'Correct customer name:' };
const DOC_LABEL = { order: 'Order', delivery: 'Delivery', invoice: 'Invoice', payment: 'Payment' } as const;
const DOC_TONE: Record<string, 'green' | 'amber' | 'red' | 'grey'> = { found: 'green', partial: 'amber', conflict: 'red', missing: 'red' };

/** Highlight extracted fields (PO, customer, quantity) in pale yellow for a moment after a photo is read. */
function Highlighted({ text, active }: { text: string; active: boolean }) {
  const [on, setOn] = useState(active);
  useEffect(() => { if (!active) return; setOn(true); const t = setTimeout(() => setOn(false), 2600); return () => clearTimeout(t); }, [active]);
  const parts = text.split(/(PO-\d+|\d+\s*(?:boxes|units|nos)?|Example Customer[^·,]*|Model [A-Z])/g);
  return <>{parts.map((p, i) => (i % 2 ? <span key={i} className={clsx('rounded-sm px-0.5 transition-colors duration-300', on && 'bg-hl')}>{p}</span> : <span key={i}>{p}</span>))}</>;
}

function ProofRow({ f, caseRef, onCorrected, canFix }: { f: Fact; caseRef: string; onCorrected: () => void; canFix: boolean }) {
  const show = useProofView((s) => s.show);
  const Icon = PROOF_ICON[f.source.kind] ?? PROOF_ICON.pdf;
  const [fixing, setFixing] = useState(false);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fresh = !!f.at && Date.now() - new Date(f.at).getTime() < 3 * 60e3;
  const corrected = f.id === 'delivered' && !!f.changed_from;
  async function save() {
    setBusy(true); setErr(null);
    try { await api.correctFact(caseRef, FIX_ID[f.id] ?? f.id, val, 'Corrected on the case page'); setFixing(false); setVal(''); onCorrected(); }
    catch (e: any) { setErr(plainError(e?.message)); }
    finally { setBusy(false); }
  }
  return (
    <div className={clsx('grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 border-b border-rule px-4 py-3.5 last:border-0 sm:grid-cols-[28px_minmax(0,1.3fr)_minmax(0,1fr)_auto] sm:items-center sm:px-5', corrected && 'bg-[#FBF3E4]')}>
      <Icon size={16} strokeWidth={1.8} className="mt-0.5 text-ink-2 sm:mt-0" />
      <div className="min-w-0">
        <div className="font-semibold leading-snug">{corrected ? `Correction: ${f.value}` : f.source?.label ?? f.label}</div>
        <div className="text-[12.5px] text-ink-3">{f.label}{f.at ? ` · ${dateIN(f.at, false)}, ${timeIN(f.at)}` : ''}{corrected ? ` · replaces ${f.changed_from}` : ''}</div>
      </div>
      <div className="col-start-2 mt-1 text-[13.5px] sm:col-start-auto sm:mt-0">
        {f.highlight ? <Highlighted text={f.value} active={fresh} /> : f.value}
        {(f as any).breakdown && <div className="text-[12px] text-ink-3">{(f as any).breakdown}</div>}
      </div>
      <div className="col-start-2 mt-2 flex flex-wrap gap-1.5 sm:col-start-auto sm:mt-0 sm:justify-end">
        <button className="chip hover:border-ink-3 hover:text-ink" onClick={() => show({ caseRef, proof: f.source })}>{f.source.kind === 'photo' ? 'View photo' : f.source.kind === 'voice' ? 'Play' : f.source.kind === 'sheet' ? 'Open sheet' : f.source.kind === 'zoho' ? 'Details' : f.source.kind === 'pdf' ? 'Open PDF' : 'Open'}</button>
        {canFix && CORRECTABLE.has(f.id) && !fixing && <button className="chip hover:border-ink-3 hover:text-ink" onClick={() => setFixing(true)}><Pencil size={11} />This is wrong</button>}
      </div>
      {fixing && (
        <div className="col-span-full mt-3 flex flex-wrap items-center gap-2 rounded bg-paper px-3 py-2.5 sm:col-start-2">
          <span className="text-[13px] text-ink-2">{FIX_LABEL[f.id] ?? 'Correct delivered quantity:'}</span>
          <input autoFocus inputMode={f.id === 'customer' ? 'text' : 'numeric'} className={clsx('input py-1 text-[13px]', f.id === 'customer' ? 'w-56' : 'w-24')} value={val} onChange={(e) => setVal(e.target.value)} placeholder={f.id === 'customer' ? 'e.g. Example Customer Pvt Ltd' : 'e.g. 70'} onKeyDown={(e) => e.key === 'Enter' && val && save()} />
          <button className="btn btn-sm" disabled={!val || busy} onClick={save}>{busy && <Loader2 size={12} className="animate-spin" />}Save</button>
          <button className="btn-ghost btn-sm" onClick={() => setFixing(false)}>Cancel</button>
          <span className="w-full text-[12px] text-ink-3">Saving makes a new version of the proof. Any open approval is cancelled and the amount is worked out again.</span>
          {err && <span className="w-full text-[12.5px] text-red">{err}</span>}
        </div>
      )}
    </div>
  );
}

function EditInvoice({ s, onDone }: { s: CaseSummaryV2; onDone: () => void }) {
  const line = s.invoice_preview!.lines[0];
  const [qty, setQty] = useState(String(line.qty));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try {
      const q = Number(qty);
      const r = await api.edit(s.approval!.id, { type: 'create_invoice', customer_id: s.customer_id, customer_name: s.customer, reference: s.po_ref, line_items: [{ item: line.item, qty: q, rate: line.rate }], amount: q * line.rate }, reason || 'Edited on case page');
      if (r && r.ok === false) setErr(`Not allowed: ${(r.errors ?? []).join('; ').replace(/₹(\d+)/g, (_: string, n: string) => inr(Number(n)))}. The amount must match the delivery proof.`);
      else onDone();
    } catch (e: any) { setErr(plainError(e?.message)); }
    finally { setBusy(false); }
  }
  return (
    <div className="mt-3 space-y-2 rounded border border-rule-2 bg-paper p-3 text-[13px]">
      <div className="flex items-center gap-2"><span className="w-20 text-ink-2">Quantity</span><input className="input w-24 py-1" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /><span className="text-ink-3">× {inr(line.rate)}</span></div>
      <input className="input py-1.5" placeholder="Why are you changing it?" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex gap-2"><button className="btn btn-sm" disabled={busy} onClick={save}>Save changes</button><button className="btn-ghost btn-sm" onClick={onDone}>Cancel</button></div>
      <div className="text-[12px] text-ink-3">Editing cancels the current approval and makes a new one. Amounts are checked against the proof.</div>
      {err && <div className="text-[12.5px] text-red">{err}</div>}
    </div>
  );
}

function CaseView({ id, guide }: { id: string; guide?: boolean }) {
  const t = useT();
  const user = useAuth((s) => s.user);
  const q = useLive(() => api.caseSummary(id, t.lang), [id, t.lang], (e: any) => (e.case_id ?? e.approval?.case_id) === id || e.type === 'connector.updated', 200);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const s = q.data;
  if (q.error && !s) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!s) return <div className="space-y-4"><Skeleton className="h-6 w-56" /><Skeleton className="h-16 w-3/4" /><Skeleton className="h-28" /><Skeleton lines={5} /></div>;
  const tone = s.journey.current === 'paid' ? 'text-green' : s.approval?.approvals.length || s.status_label?.includes('CHECK') ? 'text-amber' : s.status_label?.startsWith('NOT') ? 'text-red' : 'text-ink-3';
  const agree = s.facts.filter((f) => ['delivered', 'challan', 'voice', 'sheet'].includes(f.id)).length;
  const canFix = user?.role !== 'viewer' && s.journey.current !== 'paid' && s.journey.current !== 'invoiced' && s.journey.current !== 'verified';
  const paidStep = s.journey.steps.find((x) => x.key === 'paid');

  return (
    <div className="grid gap-x-10 gap-y-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="min-w-0">
        {guide && (
          <div className="mb-4 rounded-md border border-ink bg-card p-4 text-[13.5px]">
            <div className="font-semibold">Your first case, in 3 steps</div>
            <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-ink-2">
              <li><b className="text-ink">What happened</b>: the headline below, in plain words.</li>
              <li><b className="text-ink">The proof</b>: each row under &quot;Why we think so&quot; opens the photo, email or sheet it came from. If a number is wrong, press &quot;This is wrong&quot;.</li>
              <li><b className="text-ink">Your decision</b>: approve the invoice on the right. It is created once in Zoho and read back to check.</li>
            </ol>
          </div>
        )}
        <div className="mb-2 text-[13px] text-ink-3"><Link href="/bill" className="hover:text-ink">To bill</Link> › Case <span className="mono">{s.case_ref}</span></div>
        <div className={clsx('text-[12.5px] font-semibold uppercase tracking-[0.06em]', tone)}>{s.status_label}</div>
        <h1 className="mt-1 text-[24px] font-semibold leading-[1.15] tracking-[-0.02em] sm:text-[30px]">{s.headline}</h1>
        <p className="mt-2 text-[15px] text-ink-2">{s.recommendation}</p>

        <Card className="mt-5 p-4 sm:p-5"><Journey journey={s.journey} /></Card>

        <Card className="mt-4 grid grid-cols-2 gap-px overflow-hidden bg-rule p-0 sm:grid-cols-4">
          {s.documents.map((d) => (
            <div key={d.stage} className="bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <span className="flex items-center gap-2 font-semibold"><span className={clsx('h-2.5 w-2.5 rounded-full', d.status === 'found' ? 'bg-green' : d.status === 'partial' ? 'bg-amber' : d.stage === 'payment' && d.status === 'missing' ? 'border border-dashed border-ink-3' : 'border-2 border-dashed border-red')} />{DOC_LABEL[d.stage]}</span>
                <StatusTag tone={d.stage === 'payment' && d.status === 'missing' ? 'grey' : DOC_TONE[d.status]}>{d.stage === 'payment' && d.status === 'missing' ? 'Not due' : d.status === 'found' ? 'Found' : d.status === 'partial' ? 'Partial' : d.status === 'conflict' ? 'Conflict' : 'Missing'}</StatusTag>
              </div>
              <div className="mt-2 text-[12.5px] text-ink-3">{[d.date ? dateIN(d.date, false) : null, d.source].filter(Boolean).join(' · ') || '—'}</div>
              <div className="mt-0.5 text-[13px]">{d.key_number ?? (d.stage === 'payment' ? 'Starts after invoice' : '—')}</div>
            </div>
          ))}
        </Card>

        <AgentDecision d={s.timeline_decision} preview={s.invoice_preview} rate={s.invoice_preview?.lines[0]?.rate ?? null} />
        {s.timeline && s.timeline.length > 0 && <div className="mt-2"><WhatHappened timeline={s.timeline} /></div>}

        <div className="sect"><h2>{t('case.why')}</h2>
          <span className={clsx('inline-flex items-center gap-1 text-[13px]', s.confidence === 'high' ? 'text-green' : 'text-amber')} title={s.confidence_reason}>
            {s.confidence === 'high' ? <Check size={14} /> : <AlertTriangle size={14} />}{s.confidence === 'high' ? `High confidence · ${Math.max(agree, 1)} sources agree` : 'Needs a check'}
          </span>
        </div>
        <p className="-mt-1 mb-2 text-[12.5px] text-ink-3">{s.confidence_reason}</p>
        {s.facts.length ? (
          <Card>{s.facts.map((f) => <ProofRow key={f.id} f={f} caseRef={s.case_ref} canFix={canFix} onCorrected={q.reload} />)}</Card>
        ) : <Card><EmptyState title="No proof yet." hint="As soon as an email, challan photo or sheet row arrives for this order, it shows up here." /></Card>}

        {s.callouts.length > 0 && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {s.callouts.map((c, i) => {
              const amt = c.text.match(/₹[\d,]+/)?.[0];
              return (
                <Card key={i} className="flex gap-3 p-4">
                  {c.kind === 'quarantined' ? <ShieldAlert size={17} strokeWidth={1.8} className="mt-0.5 shrink-0 text-red" /> : <Clock size={17} strokeWidth={1.8} className="mt-0.5 shrink-0 text-amber" />}
                  <div>
                    <div className="font-semibold">{c.kind === 'approval_expired' ? <>Approval for <span className="strike text-ink-3">{amt}</span> was cancelled</> : c.kind === 'quarantined' ? '1 suspicious email ignored' : 'Count corrected'}</div>
                    <div className="mt-0.5 text-[13px] text-ink-2">{c.text}</div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        <Card className="mt-4">
          <button className="flex w-full items-start gap-3 px-4 py-3.5 text-left sm:px-5" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            <ChevronDown size={16} className={clsx('mt-0.5 shrink-0 transition-transform', open && 'rotate-180')} />
            <span><b>{t('case.how')}</b><span className="text-ink-2"> · {s.how_found.agents} agents · {s.how_found.checks} checks · {s.how_found.seconds} sec{s.how_found.extra_searches.length ? ` · ${s.how_found.extra_searches.length} extra searches` : ''}</span></span>
          </button>
          {open && (
            <div className="border-t border-rule px-4 py-3 text-[13px] sm:px-5">
              {s.how_found.extra_searches.length > 0 && <ul className="mb-3 list-disc space-y-1 pl-5 text-ink-2">{s.how_found.extra_searches.map((x) => <li key={x}>{x}</li>)}</ul>}
              <p className="text-ink-3">Every amount comes from a fixed calculation over the proof, not from AI text. The full step-by-step record is in Advanced.</p>
              <div className="mt-2 flex flex-wrap gap-2"><Link href={`/advanced/agents?id=${s.case_ref}`} className="btn-ghost btn-sm">Agent activity</Link><Link href={`/advanced/case?id=${s.case_ref}`} className="btn-ghost btn-sm">Evidence board</Link><Link href={`/advanced/audit?case=${s.case_ref}`} className="btn-ghost btn-sm">Audit log</Link></div>
            </div>
          )}
        </Card>
      </div>

      <aside className="min-w-0 xl:sticky xl:top-20 xl:self-start">
        <Card className="p-5">
          <div className="mb-4 flex items-baseline justify-between"><b className="text-[15px]">{s.journey.current === 'paid' ? 'Invoice created' : t('case.invoice')}</b><span className="text-[12.5px] text-ink-3">Zoho Books · {s.journey.current === 'paid' ? 'Sent' : 'Draft'}</span></div>
          {s.invoice_preview ? <InvoicePreview g={s.invoice_preview} customer={s.customer} poRef={s.po_ref} /> : <EmptyState title={s.journey.current === 'paid' ? 'Billed and checked.' : 'Nothing to bill yet.'} hint={s.journey.current === 'paid' ? paidStep?.caption ?? '' : 'We need delivery proof that matches before we draft an invoice.'} />}
          {s.approval && s.invoice_preview && (
            <div className="mt-5">
              {s.approval.approvers_needed > 1 && <div className="mb-2 text-[12.5px] text-amber">{s.approval.approvals.length} of {s.approval.approvers_needed} approvers{s.approval.approvals.length ? ` · ${s.approval.approvals.map((a) => a.user).join(', ')} approved` : ''} · above ₹1 lakh needs 2 different people</div>}
              <ApproveActions card={s.approval} full onDone={q.reload} showReject extra={<button className="btn-ghost" onClick={() => setEditing((v) => !v)}><Pencil size={13} />Edit</button>} />
              {editing && <EditInvoice s={s} onDone={() => { setEditing(false); q.reload(); }} />}
              <p className="mt-4 text-[12.5px] text-ink-3">After approval we create it once, read it back from Zoho to check, then draft a WhatsApp to the customer for you to send.</p>
            </div>
          )}
          {!s.approval && s.invoice_preview && s.journey.current !== 'paid' && <p className="mt-4 text-[12.5px] text-amber">No approval is open right now. {s.journey.current === 'invoiced' || s.journey.current === 'verified' ? 'Creating and checking the invoice…' : 'It will appear here once the numbers are checked.'}</p>}
        </Card>
        <ChatMemoryCard m={s.chat_memory} caseRef={s.case_ref} />
      </aside>
    </div>
  );
}

function Inner() {
  const sp = useSearchParams();
  const id = sp.get('id');
  if (!id) return <EmptyState title="No case selected" hint="Open one from Today or To bill." action={<Link href="/bill" className="btn">Open To bill</Link>} />;
  return <CaseView id={id} key={id} guide={sp.get('guide') === '1'} />;
}
export default function CasePage() {
  return <Suspense fallback={<Skeleton className="h-40" />}><Inner /></Suspense>;
}
