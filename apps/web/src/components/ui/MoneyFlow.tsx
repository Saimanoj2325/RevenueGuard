'use client';
import clsx from 'clsx';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { inr } from '@/lib/format';
import { useCountUp, prefersReducedMotion } from './motion';

export interface Flow { ordered: number; delivered: number; billed: number; paid: number }
export interface LeakNotes { notDelivered?: string; notBilled?: string; unpaid?: string }

function Fig({ v }: { v: number }) {
  const { value, flash } = useCountUp(v);
  return <span key={flash} className={clsx('serif inline-block rounded-sm text-[19px] leading-none sm:text-[26px]', flash > 0 && 'flash-once')}>{inr(value)}</span>;
}

/**
 * Ordered > Delivered > Billed > Paid bars with the leak between each pair.
 * Red = delivered but not billed (the money you earned but never asked for). Clicking a leak opens the filtered list.
 * When billed grows, a green "+₹X" chip flies from Delivered to Billed and the bars resize.
 */
export function MoneyFlow({ flow, notes, maxH = 225 }: { flow: Flow; notes?: LeakNotes; maxH?: number }) {
  const top = Math.max(flow.ordered, flow.delivered, 1);
  const h = (n: number) => Math.max(4, Math.round((n / top) * maxH));
  const wrap = useRef<HTMLDivElement>(null);
  const dRef = useRef<HTMLDivElement>(null);
  const bRef = useRef<HTMLDivElement>(null);
  const prevBilled = useRef(flow.billed);
  const [chip, setChip] = useState<{ id: number; amount: number; from: [number, number]; to: [number, number]; go: boolean } | null>(null);

  useLayoutEffect(() => {
    const diff = flow.billed - prevBilled.current;
    prevBilled.current = flow.billed;
    if (diff <= 0 || !wrap.current || !dRef.current || !bRef.current || prefersReducedMotion()) return;
    const r = wrap.current.getBoundingClientRect();
    const a = dRef.current.getBoundingClientRect();
    const b = bRef.current.getBoundingClientRect();
    const id = Date.now();
    setChip({ id, amount: diff, from: [a.left - r.left + 4, a.top - r.top + 10], to: [b.left - r.left + 4, b.top - r.top - 34], go: false });
  }, [flow.billed]);
  useEffect(() => {
    if (!chip || chip.go) return;
    const t1 = requestAnimationFrame(() => requestAnimationFrame(() => setChip((c) => (c && c.id === chip.id ? { ...c, go: true } : c))));
    const t2 = setTimeout(() => setChip((c) => (c && c.id === chip.id ? null : c)), 2400);
    return () => { cancelAnimationFrame(t1); clearTimeout(t2); };
  }, [chip]);

  const cols: { key: keyof Flow; label: string; color: string; ref?: React.Ref<HTMLDivElement> }[] = [
    { key: 'ordered', label: 'Ordered', color: 'bg-ink' },
    { key: 'delivered', label: 'Delivered', color: 'bg-ink', ref: dRef },
    { key: 'billed', label: 'Billed', color: 'bg-ink', ref: bRef },
    { key: 'paid', label: 'Paid', color: 'bg-green' },
  ];
  const leaks = [
    { amount: flow.ordered - flow.delivered, label: 'Not delivered yet', note: notes?.notDelivered, tone: 'text-ink-3', href: null as string | null },
    { amount: flow.delivered - flow.billed, label: 'Delivered, not billed', note: notes?.notBilled ?? 'click to bill', tone: 'text-red', href: '/bill' },
    { amount: flow.billed - flow.paid, label: 'Billed, unpaid', note: notes?.unpaid, tone: 'text-amber', href: '/collect' },
  ];

  return (
    <div ref={wrap} className="relative">
      <div className="grid grid-cols-[1fr_.9fr_1fr_.9fr_1fr_.9fr_1fr] items-end gap-0 px-2 pt-6 sm:px-6">
        {cols.map((c, i) => (
          <div key={c.key} className="contents">
            <div className="flex flex-col items-center">
              <Fig v={flow[c.key]} />
              <div ref={c.ref} className={clsx('mt-3 w-[70%] max-w-[132px] transition-[height] duration-1000 ease-[cubic-bezier(.2,.8,.2,1)]', c.color)} style={{ height: h(flow[c.key]) }} />
              <div className="mt-3 text-[12.5px] font-semibold sm:text-[14px]">{c.label}</div>
            </div>
            {i < 3 && (() => {
              const l = leaks[i];
              const inner = (
                <div className={clsx('flex flex-col items-center self-start px-1 pt-14 text-center', l.tone)}>
                  <ArrowRight size={15} strokeWidth={1.8} />
                  <div className="num mt-3 text-[12px] font-semibold sm:text-[15px]">– {inr(Math.max(0, l.amount))}</div>
                  <div className="mt-1 hidden text-[12.5px] leading-snug sm:block">{l.label}</div>
                  {l.note && <div className="mt-0.5 hidden text-[12px] leading-snug text-ink-3 md:block">{l.note}</div>}
                </div>
              );
              return l.href && l.amount > 0 ? <Link key={'l' + i} href={l.href} className="self-start rounded hover:bg-[#FBF9F3]" title={`Open the list: ${l.label}`}>{inner}</Link> : <div key={'l' + i} className="self-start">{inner}</div>;
            })()}
          </div>
        ))}
      </div>
      {chip && (
        <div className="pointer-events-none absolute z-10 rounded-full bg-green px-2 py-[3px] text-[12px] font-semibold text-white transition-all duration-[1100ms] ease-[cubic-bezier(.4,0,.2,1)]"
          style={{ left: chip.go ? chip.to[0] : chip.from[0], top: chip.go ? chip.to[1] : chip.from[1], opacity: chip.go ? 1 : 0.95 }}>
          +{inr(chip.amount)}
        </div>
      )}
    </div>
  );
}
