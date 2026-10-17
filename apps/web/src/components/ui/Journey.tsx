'use client';
import clsx from 'clsx';
import { AlertTriangle, Check } from 'lucide-react';
import { JOURNEY_LABELS, journeyProgress } from '@/lib/journey';
import { timeIN } from '@/lib/format';
import type { Journey as J, JourneyStep } from '@/lib/v2types';

function Dot({ s }: { s: JourneyStep }) {
  return (
    <span className={clsx('relative z-[1] grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border-2 transition-all duration-400',
      s.status === 'done' && (s.key === 'verified' || s.key === 'paid' ? 'border-green bg-green text-white' : 'border-ink bg-ink text-paper'),
      s.status === 'current' && 'animate-ring border-ink bg-card',
      s.status === 'waiting' && 'border-amber bg-amber-bg',
      s.status === 'problem' && 'border-red bg-red-bg text-red',
      s.status === 'todo' && 'border-dashed border-rule-2 bg-paper')}>
      {s.status === 'done' && <Check size={12} strokeWidth={2.6} />}
      {s.status === 'problem' && <AlertTriangle size={11} strokeWidth={2.4} />}
    </span>
  );
}

const sub = (s: JourneyStep) => s.caption ?? (s.status === 'done' && s.at ? timeIN(s.at) : '');

/** 8-step case journey. Horizontal from 640px, vertical list on phones. The ink line grows to the current step. */
export function Journey({ journey, className }: { journey: J; className?: string }) {
  const p = journeyProgress(journey);
  return (
    <div className={className}>
      {/* desktop */}
      <div className="relative hidden px-2 pb-1 pt-1 sm:flex">
        <div className="absolute left-[6.25%] right-[6.25%] top-[12px] h-[2px] bg-rule-2" />
        <div className="absolute left-[6.25%] top-[12px] h-[2px] bg-ink transition-[width] duration-700 ease-out" style={{ width: `${p * 87.5}%` }} />
        {journey.steps.map((s) => (
          <div key={s.key} className="relative flex flex-1 flex-col items-center px-1 text-center">
            <Dot s={s} />
            <div className={clsx('mt-2 text-[12.5px] font-medium leading-tight', s.status === 'todo' ? 'text-ink-3' : s.status === 'problem' ? 'text-red' : s.status === 'waiting' ? 'text-amber' : 'text-ink')}>{JOURNEY_LABELS[s.key]}</div>
            <div className={clsx('mt-0.5 min-h-[15px] text-[11px] leading-tight', s.status === 'waiting' ? 'text-amber' : s.status === 'problem' ? 'text-red' : 'text-ink-3')}>{sub(s)}</div>
          </div>
        ))}
      </div>
      {/* phone */}
      <ol className="relative space-y-3 pl-1 sm:hidden">
        {journey.steps.map((s, i) => (
          <li key={s.key} className="relative flex items-start gap-3">
            {i < journey.steps.length - 1 && <span className={clsx('absolute left-[10px] top-[24px] h-[calc(100%-10px)] w-[2px]', s.status === 'done' ? 'bg-ink' : 'bg-rule-2')} />}
            <Dot s={s} />
            <div className="min-w-0 pt-[1px]">
              <div className={clsx('text-[13.5px] font-medium', s.status === 'todo' ? 'text-ink-3' : s.status === 'problem' ? 'text-red' : s.status === 'waiting' ? 'text-amber' : 'text-ink')}>{JOURNEY_LABELS[s.key]}</div>
              {sub(s) && <div className="text-[12px] text-ink-3">{sub(s)}</div>}
            </div>
          </li>
        ))}
      </ol>
      {journey.problem && (
        <div className="mt-3 flex items-start gap-2 rounded border border-red/30 bg-red-bg/60 px-3 py-2 text-[13px]">
          <AlertTriangle size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-red" />
          <div><span className="font-medium text-red">{journey.problem.reason}</span> <span className="text-ink-2">{journey.problem.next}</span></div>
        </div>
      )}
    </div>
  );
}
