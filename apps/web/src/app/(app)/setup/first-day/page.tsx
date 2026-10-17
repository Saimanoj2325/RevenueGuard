'use client';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Brand } from '@/components/Shell';
import { ErrorState, MoneyFigure, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { inr } from '@/lib/format';
import type { Backfill } from '@/lib/v2types';

export default function FirstDay() {
  const [b, setB] = useState<Backfill | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    let stop = false;
    let t: any;
    const poll = async () => {
      try {
        let r = await api.backfill();
        if (!started.current && r.sources.every((s) => s.status === 'waiting')) { started.current = true; await api.startBackfill(90); r = await api.backfill(); }
        started.current = true;
        if (stop) return;
        setB(r); setErr(null);
        if (!r.sources.every((s) => s.status === 'done')) t = setTimeout(poll, 900);
      } catch (e: any) { if (!stop) { setErr(e?.message ?? String(e)); t = setTimeout(poll, 4000); } }
    };
    poll();
    return () => { stop = true; clearTimeout(t); };
  }, []);
  const all = !!b && b.sources.every((s) => s.status === 'done');
  return (
    <div className="mx-auto max-w-[900px] px-5 py-12 sm:py-24">
      <Brand org={false} />
      {err && !b && <ErrorState error={err} className="mt-8" />}
      {!b && !err && <Skeleton lines={5} className="mt-10" />}
      {b && (
        <>
          <div className="eyebrow mt-10">{all ? 'All 4 connected · we looked back 90 days' : 'Looking back 90 days…'}</div>
          <h1 className="mt-2 text-[28px] font-semibold leading-[1.15] tracking-[-0.02em] sm:text-[36px]">
            {all ? <>We found <MoneyFigure value={b.found_amount ?? 0} tone="red" size={38} /> you delivered but never billed.</> : 'Reading your emails, chats, sheet and Zoho…'}
          </h1>
          <p className="mt-3 text-[15px] text-ink-2">{all ? `${b.found_count} deliveries without a full invoice. Each one has proof attached.` : 'This takes a few minutes for a real business. You can leave this page; we keep going.'}</p>
          <div className="card mt-7 px-5">
            {b.sources.map((s) => (
              <div key={s.name} className="flex items-center gap-3 border-b border-rule py-3.5 last:border-0">
                {s.status === 'done' ? <Check size={16} className="shrink-0 text-green" /> : s.status === 'running' ? <Loader2 size={16} className="shrink-0 animate-spin text-ink-3" /> : <span className="h-4 w-4 shrink-0 rounded-full border border-dashed border-rule-2" />}
                <div className="min-w-0 flex-1">
                  <div className="text-[14px]">{s.status === 'waiting' ? `Waiting to read ${s.name}` : s.label}</div>
                  {s.status === 'running' && <div className="mt-1.5 h-[3px] w-full bg-rule"><div className="h-full bg-ink transition-[width] duration-700" style={{ width: `${(s.done / Math.max(1, s.total)) * 100}%` }} /></div>}
                </div>
                <span className="text-[13px] text-ink-3">{s.name}</span>
              </div>
            ))}
            {all && <div className="flex items-center gap-3 py-3.5 font-semibold"><AlertTriangle size={16} className="text-red" /><span className="flex-1">{b.found_count} deliveries have no invoice or are billed short</span><span className="text-[13px] font-normal text-ink-3">{inr(b.found_amount ?? 0)}</span></div>}
          </div>
          {all && (
            <>
              <div className="mt-6 flex flex-wrap gap-3">
                {b.first_case_ref && <Link href={`/case?id=${b.first_case_ref}&guide=1`} className="btn px-5 py-2.5 text-[14px]">Show me the first one</Link>}
                <Link href="/bill" className="btn-ghost px-5 py-2.5 text-[14px]">See all {b.found_count}</Link>
              </div>
              <p className="mt-4 text-[13px] text-ink-3">We&apos;ll walk you through one case end to end, about 1 minute. Nothing is billed until you approve.</p>
            </>
          )}
        </>
      )}
    </div>
  );
}
