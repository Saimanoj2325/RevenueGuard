'use client';
import clsx from 'clsx';
import { Check, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { inr } from '@/lib/format';
import { useAuth } from '@/lib/store';
import type { ApprovalCard } from '@/lib/v2types';
import { plainError } from '../ui';

/** Approve / Reject through the ONE existing approval endpoint. Shows plain-word results; never a second write path. */
export function ApproveActions({ card, onDone, size = 'md', showReject = true, extra, full }: { card: ApprovalCard; onDone?: () => void; size?: 'sm' | 'md'; showReject?: boolean; extra?: React.ReactNode; full?: boolean }) {
  const user = useAuth((s) => s.user);
  const [busy, setBusy] = useState<'a' | 'r' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'green' | 'red' | 'amber'; text: string } | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const done = card.approvals.length;
  const mine = card.approvals.some((a) => user?.name?.startsWith(a.user));
  const label = card.kind === 'reminder' ? 'Approve & send' : card.approvers_needed > 1 && done > 0 ? 'Approve as 2nd' : 'Approve';
  const expired = !!card.expires_reason || card.status === 'expired';

  async function approve() {
    setBusy('a'); setMsg(null);
    try {
      const a = await api.approve(card.id, card.kind === 'reminder' ? 'Reminder approved' : 'Approved');
      const left = (a.required_approvers ?? card.approvers_needed) - (a.approvers?.filter((x) => x.decision === 'approve').length ?? done + 1);
      setMsg(left > 0 ? { tone: 'amber', text: `Approved. Needs ${left} more approver.` } : { tone: 'green', text: card.kind === 'reminder' ? 'Approved. Sending the reminder now.' : `Approved. Creating the ${inr(card.total)} invoice in Zoho, then checking it.` });
      onDone?.();
    } catch (e: any) { setMsg({ tone: 'red', text: plainError(e?.message) }); }
    finally { setBusy(null); }
  }
  async function reject() {
    if (!reason.trim()) return;
    setBusy('r');
    try { await api.reject(card.id, reason.trim()); setMsg({ tone: 'amber', text: 'Rejected. Nothing was billed or sent.' }); setRejecting(false); onDone?.(); }
    catch (e: any) { setMsg({ tone: 'red', text: plainError(e?.message) }); }
    finally { setBusy(null); }
  }
  if (expired) return <div className="text-[12.5px] text-amber">{card.expires_reason ?? 'This approval expired.'}</div>;
  return (
    <div className={clsx(full && 'w-full')}>
      {!rejecting ? (
        <div className={clsx('flex flex-wrap items-center gap-2', full && '[&>button]:flex-1')}>
          <button className={clsx('btn-green', size === 'sm' && 'btn-sm')} disabled={!!busy || mine} onClick={approve} title={mine ? 'You already approved. A different person must approve too.' : undefined}>
            <Check size={14} strokeWidth={2.2} className={clsx(busy === 'a' && 'animate-pulse')} />{mine ? 'You approved' : label}
          </button>
          {extra}
          {showReject && <button className={clsx('btn-ghost', size === 'sm' && 'btn-sm')} disabled={!!busy} onClick={() => setRejecting(true)}><X size={14} />Reject</button>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input autoFocus className="input max-w-[280px] py-1.5 text-[13px]" placeholder="Why? (the team sees this)" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && reject()} />
          <button className="btn btn-sm" disabled={!reason.trim() || !!busy} onClick={reject}>Reject</button>
          <button className="btn-ghost btn-sm" onClick={() => setRejecting(false)}>Cancel</button>
        </div>
      )}
      {msg && <div className={clsx('mt-2 text-[12.5px]', msg.tone === 'green' ? 'text-green' : msg.tone === 'red' ? 'text-red' : 'text-amber')} role="status">{msg.text}</div>}
    </div>
  );
}

export function approverLine(card: ApprovalCard) {
  if (card.approvers_needed > 1) {
    const done = card.approvals.length;
    return done ? `needs ${card.approvers_needed} approvers · ${card.approvals.map((a) => a.user).join(', ')} approved` : `needs ${card.approvers_needed} approvers`;
  }
  return '1 approver';
}
