'use client';
import clsx from 'clsx';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { MoneyFigure, type Tone } from './Money';

/** Shrinks big figures on phones so ₹2,15,500 never overflows a half-width cell. */
const fit = (size: number, wide: boolean | undefined, n: number) => `clamp(22px, ${wide || n < 3 ? 10.5 : 6.6}vw, ${size}px)`;

export interface Stat { label: ReactNode; value?: number; text?: ReactNode; tone?: Tone; labelTone?: Tone; note?: ReactNode; href?: string; caps?: boolean }

/** Row of big figures in one ruled card (money strip). Stacks on phones. */
export function StatStrip({ stats, size = 34, className, firstWide }: { stats: Stat[]; size?: number; className?: string; firstWide?: boolean }) {
  return (
    <div className={clsx('grid gap-px overflow-hidden rounded-md border border-rule-2 bg-rule', stats.length === 4 ? 'grid-cols-2 lg:grid-cols-4' : stats.length === 3 ? (firstWide ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-3') : 'grid-cols-2', className)}>
      {stats.map((s, i) => {
        const body = (
          <>
            <div className={clsx('text-[12px] font-semibold', s.caps !== false && 'uppercase tracking-[0.06em]', s.labelTone ? { red: 'text-red', amber: 'text-amber', green: 'text-green', ink: 'text-ink', muted: 'text-ink-3' }[s.labelTone] : 'text-ink-2')}>{s.label}</div>
            <div className="mt-2">{s.value !== undefined ? <MoneyFigure value={s.value} tone={s.tone ?? 'ink'} size={fit(size, firstWide && i === 0, stats.length)} /> : <span className={clsx('serif leading-none', s.tone === 'amber' ? 'text-amber' : s.tone === 'red' ? 'text-red' : s.tone === 'green' ? 'text-green' : 'text-ink')} style={{ fontSize: fit(size, firstWide && i === 0, stats.length) }}>{s.text}</span>}</div>
            {s.note && <div className="mt-2 text-[12.5px] text-ink-3">{s.note}</div>}
          </>
        );
        const cls = clsx('min-w-0 bg-card px-4 py-4 sm:px-6 sm:py-5', firstWide && i === 0 && 'col-span-2 sm:col-span-1');
        return s.href ? <Link key={i} href={s.href} className={clsx(cls, 'block hover:bg-[#FBF9F3]')}>{body}</Link> : <div key={i} className={cls}>{body}</div>;
      })}
    </div>
  );
}
