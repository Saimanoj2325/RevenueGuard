'use client';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import { Fragment } from 'react';
import { useUi } from '@/lib/store';
import { STAGES, type TimelineEntry } from '@/lib/types';

const TONE: Record<string, string> = { found: '#1E5A3C', partial: '#9A6A12', conflict: '#B23A26', missing: '#B23A26' };

export function TimelineSpine({ timeline }: { timeline: TimelineEntry[] }) {
  const setHover = useUi((s) => s.setHover);
  const by = Object.fromEntries(timeline.map((t) => [t.stage, t]));
  return (
    <div className="panel px-4 py-4 sm:px-6" aria-label="Transaction timeline">
      <div className="flex items-stretch">
        {STAGES.map((s, i) => {
          const t = by[s] as TimelineEntry | undefined;
          const st = t?.status ?? 'missing';
          const next = by[STAGES[i + 1]] as TimelineEntry | undefined;
          const broken = st === 'missing' || (next && next.status === 'missing');
          return (
            <Fragment key={s}>
              <button
                type="button"
                onMouseEnter={() => setHover(t?.evidence_node_ids ?? [])}
                onMouseLeave={() => setHover([])}
                onFocus={() => setHover(t?.evidence_node_ids ?? [])}
                onBlur={() => setHover([])}
                className="group flex min-w-0 shrink-0 flex-col items-center gap-1.5 text-center"
              >
                <motion.span
                  layout
                  className={clsx('relative grid h-9 w-9 place-items-center rounded-full border-2 sm:h-10 sm:w-10', st === 'missing' ? 'border-dashed bg-transparent' : 'bg-paper')}
                  style={{ borderColor: TONE[st] }}
                  animate={st === 'conflict' ? { scale: [1, 1.12, 1] } : { scale: 1 }}
                  transition={st === 'conflict' ? { repeat: Infinity, duration: 1.2 } : undefined}
                >
                  {st === 'missing' ? <span className="num text-[13px] font-bold text-red">?</span> : <span className="h-2.5 w-2.5 rounded-full" style={{ background: TONE[st] }} />}
                </motion.span>
                <span className="num text-[10.5px] uppercase tracking-[0.18em] text-ink-2">{s}</span>
                <span className="num text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: TONE[st] }}>{st}</span>
                <span className="hidden max-w-[150px] truncate text-[11px] text-ink-3 sm:block" title={t?.note}>{t?.note ?? `${t?.evidence_node_ids.length ?? 0} source(s)`}</span>
              </button>
              {i < STAGES.length - 1 && (
                <div className="relative mx-1 mt-[17px] h-[3px] flex-1 sm:mt-5">
                  {broken ? (
                    <svg className="absolute inset-0 h-[10px] w-full -translate-y-[3px]" preserveAspectRatio="none" viewBox="0 0 100 10" aria-hidden>
                      <path d="M0 5 L42 5" stroke="#B23A26" strokeWidth="2" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
                      <path d="M42 5 L45 1 L48 8 L51 2 L54 7 L57 5" stroke="#B23A26" strokeWidth="1.2" fill="none" vectorEffect="non-scaling-stroke" />
                      <path d="M60 5 L100 5" stroke="#B23A26" strokeWidth="2" strokeDasharray="3 3" opacity=".5" vectorEffect="non-scaling-stroke" />
                    </svg>
                  ) : (
                    <motion.div className="h-full origin-left rounded bg-amber" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.6 }} />
                  )}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
