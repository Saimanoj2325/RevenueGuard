'use client';
import clsx from 'clsx';
import { CheckCircle2, Loader2, Siren } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Empty, ErrorNote, PageHead, Skeleton, Stamp } from '@/components/legacy/ui';
import { api } from '@/lib/api';
import { ago, human } from '@/lib/format';
import { useLive, useNow } from '@/lib/hooks';
import type { Escalation } from '@/lib/types';

export default function EscalationsPage() {
  const q = useLive(() => api.escalations(), [], (e) => e.type === 'case.updated' || (e.type === 'guardrail' && e.kind === 'escalated'), 400);
  const now = useNow();
  const open = (q.data ?? []).filter((e) => e.status !== 'resolved');
  const done = (q.data ?? []).filter((e) => e.status === 'resolved');
  return (
    <div>
      <PageHead kicker="needs a human" title="Escalations" />
      <p className="-mt-2 mb-4 max-w-2xl text-[13px] text-ink-3">Conflicting evidence, exhausted budgets, invalid model output after two retries, or a rejected proposal. The system does not guess past these.</p>
      <ErrorNote error={q.error} />
      {!q.data ? <Skeleton className="h-40" /> : open.length === 0 && done.length === 0 ? (
        <Empty icon={<Siren className="text-ink-3" />} title="No escalations" />
      ) : (
        <div className="space-y-3">
          {open.map((e) => <Row key={e.id} e={e} now={now} onDone={q.reload} />)}
          {done.length > 0 && <div className="eyebrow pt-4">resolved</div>}
          {done.map((e) => <Row key={e.id} e={e} now={now} onDone={q.reload} />)}
        </div>
      )}
    </div>
  );
}

function Row({ e, now, onDone }: { e: Escalation; now: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const resolved = e.status === 'resolved';
  return (
    <div className={clsx('panel flex flex-wrap items-start gap-4 p-4', resolved && 'opacity-60')}>
      <div className={clsx('grid h-10 w-10 shrink-0 place-items-center rounded-full border', resolved ? 'border-green/50 text-green' : 'border-red/60 text-red')}>
        {resolved ? <CheckCircle2 size={18} /> : <Siren size={18} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/advanced/case?id=${e.case_id}`} className="num text-[15px] font-semibold text-ink hover:underline">{e.case_id}</Link>
          <Stamp color={resolved ? '#1E5A3C' : '#B23A26'}>{human(e.reason)}</Stamp>
          <span className="num text-[11px] text-ink-3">{ago(e.created_at, now)}</span>
        </div>
        <p className="mt-1 text-[13px] leading-snug text-ink-2">{e.detail}</p>
        <ErrorNote error={err} />
      </div>
      {!resolved && (
        <div className="flex gap-2">
          <Link href={`/advanced/case?id=${e.case_id}`} className="btn-ghost">Open case</Link>
          <button className="btn-paper" disabled={busy} onClick={async () => { setBusy(true); try { await api.resolveEscalation(e.id); onDone(); } catch (x: any) { setErr(x.message); } finally { setBusy(false); } }}>
            {busy && <Loader2 size={14} className="animate-spin" />}Mark resolved
          </button>
        </div>
      )}
    </div>
  );
}
