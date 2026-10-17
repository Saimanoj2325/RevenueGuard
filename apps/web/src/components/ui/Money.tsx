'use client';
import clsx from 'clsx';
import { inr } from '@/lib/format';
import { useCountUp } from './motion';

export type Tone = 'ink' | 'red' | 'amber' | 'green' | 'muted';
const TONE: Record<Tone, string> = { ink: 'text-ink', red: 'text-red', amber: 'text-amber', green: 'text-green', muted: 'text-ink-3' };

/** Inline rupee amount, Indian grouping, tabular numerals. */
export function Money({ value, tone = 'ink', className, strike }: { value: number | null | undefined; tone?: Tone; className?: string; strike?: boolean }) {
  return <span className={clsx('num whitespace-nowrap', TONE[tone], strike && 'strike', className)}>{inr(value)}</span>;
}

/** Big Fraunces money figure that counts up/down and flashes pale yellow when it changes. */
export function MoneyFigure({ value, tone = 'ink', size = 34, className, animate = true }: { value: number; tone?: Tone; size?: number | string; className?: string; animate?: boolean }) {
  const { value: v, flash } = useCountUp(value);
  const shown = animate ? v : value;
  return (
    <span key={flash} className={clsx('serif inline-block whitespace-nowrap rounded-sm leading-none tracking-[-0.01em]', TONE[tone], flash > 0 && 'flash-once', className)} style={{ fontSize: size }}>
      {inr(shown)}
    </span>
  );
}
