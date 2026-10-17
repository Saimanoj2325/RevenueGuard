'use client';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Calculator, Check, CircleDashed, Loader2, Pencil, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { clock, dateTime, factsOf, human, inr, shortHash } from '@/lib/format';
import { useAuth, useUi } from '@/lib/store';
import type { Approval, AuditRow, CaseDetail, LineItem, ResolutionAction } from '@/lib/types';
import { CopyText, ProbList, SeverityBar, SourceIcon, Stamp, guardMeta } from '@/components/legacy/ui';

// ---------------- deterministic facts ----------------
export function FactsPanel({ detail }: { detail: CaseDetail }) {
  const f = factsOf(detail);
  const amount = detail.proposal?.action.amount;
  const match = f?.billable_amount !== undefined && amount !== undefined ? f.billable_amount === amount : null;
  return (
    <div className="panel">
      <div className="panel-h">
        <span className="panel-t flex items-center gap-2"><Calculator size={15} className="text-amber" />Deterministic facts</span>
        <span className="num text-[10px] uppercase tracking-wider text-ink-3">validator · Decimal</span>
      </div>
      {!f ? (
        <div className="px-4 py-6 text-sm text-ink-3">Validator has not run yet (case reaches VALIDATED after evidence is ready).</div>
      ) : (
        <div className="px-4 py-3">
          <div className="num grid grid-cols-[1fr_auto] gap-y-1 text-[12.5px]">
            <span className="text-ink-3">ref</span><span className="text-right text-ink">{f.ref_normalized}</span>
            <span className="text-ink-3">order qty</span><span className="text-right text-ink">{f.order_qty}</span>
            <span className="text-ink-3">delivered qty</span><span className="text-right text-[#9A6A12]">{f.delivered_qty}</span>
            <span className="text-ink-3">rate</span><span className="text-right text-ink">{inr(f.rate)}</span>
            <span className="text-ink-3">rule</span><span className="text-right text-ink">{f.rule}</span>
            <span className="text-ink-3">duplicates</span><span className="text-right text-ink">{f.duplicates?.length ? f.duplicates.join(', ') : 'none'}</span>
          </div>
          <div className="mt-3 rounded-md border border-amber/40 bg-amber/5 px-3 py-2.5">
            <div className="eyebrow">billable</div>
            <div className="num mt-0.5 text-[13px] text-ink-2">{f.billable_qty} × {inr(f.rate)} =</div>
            <motion.div key={f.billable_amount} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="num text-[28px] font-semibold leading-tight text-[#1A1A17]">{inr(f.billable_amount)}</motion.div>
          </div>
          {match !== null && (
            <div className={clsx('mt-2 flex items-center gap-1.5 text-[12px]', match ? 'text-[#1E5A3C]' : 'text-[#B23A26]')}>
              {match ? <Check size={14} /> : <AlertTriangle size={14} />}
              proposal {inr(amount)} {match ? '== billable' : '≠ billable — validator overrides'}
            </div>
          )}
          {f.ref_variants && <div className="num mt-2 text-[10.5px] text-ink-3">variants: {f.ref_variants.join(' · ')}</div>}
        </div>
      )}
    </div>
  );
}

export function LayaPanel({ detail }: { detail: CaseDetail }) {
  const l = detail.laya;
  return (
    <div className="panel">
      <div className="panel-h">
        <span className="panel-t">Laya triage</span>
        <span className="num text-[10px] text-ink-3">{l?.model ?? '—'}{l?.latency_ms ? ` · ${l.latency_ms}ms` : ''}{l?.fallback ? ' · fallback' : ''}</span>
      </div>
      {!l ? <div className="px-4 py-6 text-sm text-ink-3">Not triaged yet.</div> : (
        <div className="space-y-3 px-4 py-3">
          <div>
            <div className="eyebrow mb-1.5">severity distribution</div>
            <SeverityBar probs={l.answers.severity?.probs} severity={detail.case.severity} />
          </div>
          {Object.entries(l.answers).filter(([k]) => k !== 'severity').map(([k, a]) => (
            <div key={k}>
              <div className="eyebrow mb-1">{human(k)} → <span className="text-ink-2">{human(String(a.value))}</span></div>
              <ProbList probs={a.probs} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- proposal + claims ----------------
export function ProposalPanel({ detail, compact }: { detail: CaseDetail; compact?: boolean }) {
  const p = detail.proposal;
  const setHover = useUi((s) => s.setHover);
  const nodeById = Object.fromEntries(detail.evidence.nodes.map((n) => [n.id, n]));
  if (!p) return (
    <div className="panel px-4 py-6 text-sm text-ink-3"><div className="panel-t mb-1">Proposal</div>No proposal yet — resolution runs after investigation closes the gap.</div>
  );
  return (
    <div className="paper overflow-hidden">
      <div className="flex items-start justify-between border-b border-rule px-4 py-3">
        <div>
          <div className="eyebrow">proposal {p.version ? `v${p.version}` : ''} · {human(p.action.type)}</div>
          <div className="num mt-0.5 text-[26px] font-semibold leading-none">{inr(p.action.amount)}</div>
          <div className="mt-1 text-[12.5px] text-ink-3">{p.action.customer_name} · {p.action.reference}</div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <Stamp color={p.risk === 'low' ? '#1E5A3C' : p.risk === 'medium' ? '#9A6A12' : '#B7281F'}>risk {p.risk}</Stamp>
          {p.validation && <span className={clsx('num text-[10px]', p.validation.ok ? 'text-[#1E5A3C]' : 'text-red')}>{p.validation.ok ? 'validator ✓' : 'validator ✗'}</span>}
        </div>
      </div>
      {!compact && (
        <table className="num w-full text-[12px]">
          <thead><tr className="text-left text-[9.5px] uppercase tracking-wider text-ink-3"><th className="px-4 py-1.5 font-normal">item</th><th className="font-normal">qty</th><th className="font-normal">rate</th><th className="px-4 text-right font-normal">line</th></tr></thead>
          <tbody>
            {p.action.line_items.map((li, i) => (
              <tr key={i} className="border-t border-dashed border-rule"><td className="px-4 py-1.5">{li.item}</td><td>{li.qty}</td><td>{inr(li.rate)}</td><td className="px-4 text-right">{inr(li.qty * li.rate)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {p.action.message && <div className="mx-4 my-2 rounded-[3px] border border-rule bg-[#FFFEFA] px-2.5 py-2 text-[12.5px] italic">“{p.action.message}” <span className="num not-italic text-[10px] text-ink-3">via {p.action.channel}</span></div>}
      {p.validation && !p.validation.ok && (
        <div className="mx-4 my-2 rounded-[3px] border border-red/40 bg-red/5 px-2.5 py-2 text-[12px] text-red">{p.validation.errors?.join('; ')}</div>
      )}
      <div className="px-4 pb-3 pt-2">
        <div className="eyebrow mb-1">claims → cited evidence <span className="normal-case tracking-normal">(hover to light up the board)</span></div>
        <ul>
          {p.claims.map((c, i) => {
            const ok = c.evidence_node_ids.length > 0 && c.evidence_node_ids.every((id) => nodeById[id]);
            return (
              <li key={i} className="tick-row cursor-help rounded-sm transition hover:bg-paper-2"
                onMouseEnter={() => setHover(c.evidence_node_ids)} onMouseLeave={() => setHover([])}
                onFocus={() => setHover(c.evidence_node_ids)} onBlur={() => setHover([])} tabIndex={0}>
                <span className={clsx('num mt-[2px] shrink-0 text-[10px]', ok ? 'text-[#1E5A3C]' : 'text-red')}>{ok ? '✓' : '✗'}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] leading-snug">{c.text}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {c.evidence_node_ids.map((id) => (
                      <span key={id} className="num inline-flex items-center gap-1 rounded-[3px] border border-rule bg-[#FFFEFA] px-1.5 py-[1px] text-[10px] text-ink-3">
                        {nodeById[id] && <SourceIcon source={nodeById[id].source} kind={nodeById[id].kind} size={10} />}{nodeById[id]?.title?.slice(0, 26) ?? id}
                      </span>
                    ))}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {p.uncertainty.length > 0 && (
          <div className="mt-2">
            <div className="eyebrow mb-1">uncertainty</div>
            <ul className="list-inside list-disc text-[12.5px] text-ink-3">{p.uncertainty.map((u, i) => <li key={i}>{u}</li>)}</ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- approval ----------------
const GUARD_KINDS = ['role_block', 'approval_expired', 'duplicate_block', 'validator_block', 'kill_switch'];

export function ApprovalPanel({ detail, audit, onChanged }: { detail: CaseDetail; audit: AuditRow[]; onChanged: () => void }) {
  const user = useAuth((s) => s.user);
  const approvals = [...detail.approvals].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  const current = approvals.find((a) => a.status === 'pending' || a.status === 'partially_approved') ?? approvals[0];
  const history = approvals.filter((a) => a !== current);
  const guards = audit.filter((r) => GUARD_KINDS.some((k) => r.action === `guardrail.${k}`)).slice(0, 8);

  return (
    <div className="space-y-3">
      {current ? <ApprovalSlip a={current} detail={detail} role={user?.role} email={user?.email} onChanged={onChanged} /> : (
        <div className="panel px-4 py-6 text-sm text-ink-3"><div className="panel-t mb-1">Approval</div>No approval requested yet.</div>
      )}
      {history.length > 0 && (
        <div className="panel">
          <div className="panel-h"><span className="panel-t">Earlier approvals</span></div>
          <ul className="px-4 py-2">
            {history.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 border-b border-rule py-2 text-[12.5px] last:border-0">
                <span className="num text-ink-2">{a.id}</span>
                <span className="num text-ink">{inr(a.amount)}</span>
                <Stamp color={a.status === 'expired' ? '#9A6A12' : a.status === 'approved' ? '#1E5A3C' : '#B23A26'}>{a.status}</Stamp>
                {a.expires_reason && <span className="w-full text-[11.5px] text-ink-3">{a.expires_reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="panel">
        <div className="panel-h"><span className="panel-t">Guardrail events</span><span className="num text-[10px] text-ink-3">role · expiry · duplicate</span></div>
        <ul className="px-3 py-1.5">
          {guards.length === 0 && <li className="px-1 py-3 text-[12.5px] text-ink-3">None for this case.</li>}
          {guards.map((g) => {
            const m = guardMeta(g.action.slice(10));
            return (
              <li key={g.id} className="flex items-start gap-2 border-b border-rule px-1 py-2 last:border-0">
                <m.Icon size={14} style={{ color: m.color }} className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="num text-[10.5px] uppercase tracking-wider" style={{ color: m.color }}>{m.label} · {clock(g.ts)}</div>
                  <div className="text-[12px] leading-snug text-ink-2">{typeof g.detail === 'string' ? g.detail : JSON.stringify(g.detail)}</div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function ApprovalSlip({ a, detail, role, email, onChanged }: { a: Approval; detail: CaseDetail; role?: string; email?: string; onChanged: () => void }) {
  const [mode, setMode] = useState<'none' | 'reject' | 'edit'>('none');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [items, setItems] = useState<LineItem[]>(detail.proposal?.action.line_items ?? []);
  const open = a.status === 'pending' || a.status === 'partially_approved';
  const stale = (detail.case.evidence_version ?? 0) !== a.evidence_version;
  const canApprove = role === 'finance_approver';
  const already = a.approvers.some((x) => x.email === email);

  async function run(kind: 'approve' | 'reject' | 'edit') {
    setBusy(kind); setErr(null);
    try {
      if (kind === 'approve') await api.approve(a.id, comment || 'Approved');
      if (kind === 'reject') await api.reject(a.id, comment);
      if (kind === 'edit') {
        const action: ResolutionAction = { ...(detail.proposal!.action), line_items: items, amount: items.reduce((s, l) => s + l.qty * l.rate, 0) };
        const r = await api.edit(a.id, action, comment);
        if (r && r.ok === false) setErr('Validator rejected the edit: ' + (r.errors ?? []).join('; '));
      }
      setMode('none'); setComment('');
      onChanged();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally { setBusy(null); }
  }

  const statusColor = { pending: '#9A6A12', partially_approved: '#9A6A12', approved: '#1E5A3C', rejected: '#B7281F', expired: '#B7281F' }[a.status];
  return (
    <div className="paper relative overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <div className="eyebrow">approval slip · {a.id}</div>
          <div className="num mt-0.5 text-[24px] font-semibold leading-none">{inr(a.amount ?? detail.proposal?.action.amount)}</div>
          <div className="mt-1 text-[12px] text-ink-3">{human(a.action_type ?? detail.proposal?.action.type)} · {a.customer ?? detail.case.customer}</div>
        </div>
        <motion.div key={a.status} initial={{ scale: 1.6, opacity: 0, rotate: -14 }} animate={{ scale: 1, opacity: 1, rotate: -6 }} transition={{ type: 'spring', damping: 12 }}>
          <Stamp color={statusColor} className="px-3 py-1 text-[13px]">{human(a.status)}</Stamp>
        </motion.div>
      </div>
      <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 px-4 py-3 text-[12.5px]">
        <dt className="eyebrow pt-0.5">payload hash</dt><dd className="min-w-0"><CopyText text={a.payload_hash} display={shortHash(a.payload_hash, 14)} className="text-[11.5px]" /></dd>
        <dt className="eyebrow pt-0.5">evidence ver.</dt>
        <dd className="num text-[12px]">v{a.evidence_version} {stale ? <span className="ml-1 text-red">≠ case v{detail.case.evidence_version} — stale</span> : <span className="ml-1 text-[#1E5A3C]">= case ✓</span>}</dd>
        <dt className="eyebrow pt-0.5">approvers</dt><dd className="num text-[12px]">{a.approvers.filter((x) => x.decision !== 'reject').length}/{a.required_approvers} distinct finance_approver{a.required_approvers > 1 ? 's (> ₹1,00,000)' : ''}</dd>
        {a.expires_reason && (<><dt className="eyebrow pt-0.5 text-red">expired</dt><dd className="text-[12px] text-red">{a.expires_reason}</dd></>)}
      </dl>
      {/* signature lines */}
      <div className="grid gap-3 px-4 pb-3 sm:grid-cols-2">
        {Array.from({ length: Math.max(a.required_approvers, a.approvers.length) }).map((_, i) => {
          const ap = a.approvers[i];
          return (
            <div key={i} className="min-w-0">
              <div className="flex h-8 items-end">
                {ap ? <span className={clsx('serif truncate text-[19px] italic', ap.decision === 'reject' ? 'text-red line-through' : 'text-[#55534C]')}>{ap.email.split('@')[0]}</span> : <CircleDashed size={14} className="mb-1 text-ink-3" />}
              </div>
              <div className="border-t border-ink/60 pt-0.5 text-[10px] text-ink-3">{ap ? `${ap.decision} · ${dateTime(ap.ts)}${ap.comment ? ` · “${ap.comment}”` : ''}` : `signature ${i + 1}`}</div>
            </div>
          );
        })}
      </div>

      {open && (
        <div className="border-t border-rule bg-paper-2/60 px-4 py-3">
          {!canApprove && (
            <div className="mb-2 flex items-start gap-1.5 text-[12px] text-[#9A6A12]">
              <ShieldCheck size={14} className="mt-[1px] shrink-0" />
              Signed in as {role ? human(role) : 'unknown'} — approval needs finance_approver. Trying anyway will be blocked and audited.
            </div>
          )}
          <AnimatePresence initial={false}>
            {mode === 'edit' && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="mb-2 space-y-1.5">
                  {items.map((li, i) => (
                    <div key={i} className="grid grid-cols-[1fr_70px_90px_28px] gap-1.5">
                      <input className="input-paper" value={li.item} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, item: e.target.value } : x)))} aria-label="item" />
                      <input className="input-paper num" type="number" value={li.qty} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} aria-label="qty" />
                      <input className="input-paper num" type="number" value={li.rate} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)))} aria-label="rate" />
                      <button className="text-ink-3 hover:text-red" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="remove line"><Trash2 size={14} /></button>
                    </div>
                  ))}
                  <div className="flex items-center justify-between">
                    <button className="flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink" onClick={() => setItems([...items, { item: 'Model X', qty: 1, rate: 1000 }])}><Plus size={12} />line</button>
                    <span className="num text-[12px]">new total {inr(items.reduce((s, l) => s + l.qty * l.rate, 0))}</span>
                  </div>
                  <div className="text-[11.5px] text-ink-3">Editing creates a new proposal version → re-validation. This approval expires.</div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <textarea className="input-paper min-h-[54px] resize-y" placeholder={mode === 'none' ? 'Comment (optional for approve)' : 'Reason (required)'} value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Reason or comment" />
          {err && <div className="mt-2 rounded-[3px] border border-red/40 bg-red/10 px-2 py-1.5 text-[12px] text-red">{err}</div>}
          <div className="mt-2 flex flex-wrap gap-2">
            {mode === 'none' ? (
              <>
                <button className="btn bg-[#1E5A3C] text-ink hover:brightness-110" disabled={!!busy || already} onClick={() => run('approve')}>
                  {busy === 'approve' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {already ? 'You approved' : 'Approve'}
                </button>
                <button className="btn-paper" disabled={!!busy} onClick={() => setMode('reject')}><X size={14} />Reject</button>
                <button className="btn-paper" disabled={!!busy || !detail.proposal} onClick={() => { setItems(detail.proposal?.action.line_items ?? []); setMode('edit'); }}><Pencil size={14} />Edit</button>
              </>
            ) : (
              <>
                <button className={clsx('btn text-ink', mode === 'reject' ? 'bg-red hover:brightness-110' : 'bg-ink hover:bg-black')} disabled={!!busy || comment.trim().length < 3} onClick={() => run(mode)}>
                  {busy ? <Loader2 size={14} className="animate-spin" /> : null}{mode === 'reject' ? 'Confirm reject' : 'Submit edit'}
                </button>
                <button className="btn-paper" onClick={() => { setMode('none'); setErr(null); }}>Cancel</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- execution + verifier ----------------
export function ExecutionPanel({ detail }: { detail: CaseDetail }) {
  const v = detail.verification;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="panel">
        <div className="panel-h"><span className="panel-t">Action gateway</span><span className="num text-[10px] text-ink-3">approved payload only · idempotent</span></div>
        <ul className="px-4 py-2">
          {detail.actions.length === 0 && <li className="py-6 text-center text-sm text-ink-3">No writes yet. Nothing executes without an approved, current approval.</li>}
          {detail.actions.map((a) => (
            <li key={a.id} className="border-b border-rule py-2.5 last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="num text-[12.5px] text-ink">{human(a.type)}</span>
                <span className={clsx('chip', a.status === 'succeeded' ? 'border-green/50 text-[#1E5A3C]' : a.status === 'pending' ? 'border-ink-2/50 text-[#55534C]' : 'border-red/60 text-[#B23A26]')}>
                  {a.status === 'pending' && <Loader2 size={10} className="animate-spin" />}{a.status}
                </span>
                {a.target_id && <span className="num text-[12.5px] text-amber">{a.target_id}</span>}
                <span className="num ml-auto text-[10.5px] text-ink-3">{clock(a.ts)}</span>
              </div>
              {a.idempotency_key && <div className="num mt-1 text-[10.5px] text-ink-3">idempotency_key {a.idempotency_key}</div>}
              {a.detail && <div className="mt-0.5 text-[12px] text-ink-2">{a.detail}</div>}
            </li>
          ))}
        </ul>
      </div>
      <div className="paper relative overflow-hidden">
        <div className="flex items-center justify-between border-b border-rule px-4 py-2.5">
          <span className="serif text-[15px] font-semibold">Independent verifier · read-back</span>
          {v?.status === 'passed' && <Stamp color="#1E5A3C" className="px-2.5 py-1 text-[12px]">verified</Stamp>}
          {v?.status === 'failed' && <Stamp color="#B7281F">failed</Stamp>}
        </div>
        {!v ? <div className="px-4 py-6 text-sm text-ink-3">Runs after execution: reads the target system back and compares every important field.</div> : (
          <ul className="px-4 py-2">
            {v.checks.map((c, i) => (
              <li key={i} className="tick-row items-center">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-[3px] border border-rule bg-[#FFFEFA]">
                  {c.ok === null ? <Loader2 size={11} className="animate-spin text-ink-3" /> : c.ok ? <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }}><Check size={13} className="text-[#1E5A3C]" /></motion.span> : <X size={13} className="text-red" />}
                </span>
                <span className="flex-1 text-[12.5px]">{c.name}</span>
                <span className="num max-w-[45%] truncate text-right text-[11px] text-ink-3" title={`expected ${String(c.expected)} · actual ${String(c.actual)}`}>
                  {String(c.expected)}{c.ok !== null && <> → <span className={c.ok ? 'text-[#1E5A3C]' : 'text-red'}>{String(c.actual)}</span></>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------- audit trail ----------------
export function AuditTrail({ rows, max }: { rows: AuditRow[]; max?: number }) {
  const list = max ? rows.slice(0, max) : rows;
  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-[12.5px]">
          <thead className="border-b border-rule">
            <tr>{['time', 'actor', 'action', 'transition', 'detail'].map((h) => <th key={h} className="eyebrow px-3 py-2 font-normal">{h}</th>)}</tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const g = r.action.startsWith('guardrail.');
              return (
                <tr key={r.id} className={clsx('border-b border-rule align-top last:border-0', g && 'bg-red/5')}>
                  <td className="num whitespace-nowrap px-3 py-1.5 text-[11px] text-ink-3">{dateTime(r.ts)}</td>
                  <td className="num whitespace-nowrap px-3 py-1.5 text-[11.5px] text-amber">{r.actor}</td>
                  <td className={clsx('num whitespace-nowrap px-3 py-1.5 text-[11.5px]', g ? 'text-[#B23A26]' : 'text-ink')}>{r.action}</td>
                  <td className="num whitespace-nowrap px-3 py-1.5 text-[11px] text-ink-2">{r.state_to ? `${r.state_from ?? '∅'} → ${r.state_to}` : ''}</td>
                  <td className="px-3 py-1.5 text-[12px] text-ink-2">{typeof r.detail === 'string' ? r.detail : r.detail ? JSON.stringify(r.detail) : ''}{r.case_id && max === undefined ? <span className="num ml-2 text-[10.5px] text-ink-3">{r.case_id}</span> : null}</td>
                </tr>
              );
            })}
            {list.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-ink-3">No audit rows.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
