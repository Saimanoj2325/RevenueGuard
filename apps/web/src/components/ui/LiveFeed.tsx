'use client';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import type { FeedLine } from '@/lib/captions';
import { timeIN } from '@/lib/format';
import { useWs } from '@/lib/store';
import { prefersReducedMotion } from './motion';
import { EmptyState } from './States';

const TONE = { ink: 'text-ink', red: 'text-red', amber: 'text-amber', green: 'text-green' } as const;

export function LivePulse({ label = 'Live' }: { label?: string }) {
  const status = useWs((s) => s.status);
  const ok = status === 'open';
  return (
    <span className={clsx('inline-flex items-center gap-1.5 text-[12px] font-semibold', ok ? 'text-green' : 'text-amber')}>
      <span className={clsx('h-2 w-2 rounded-full', ok ? 'animate-ringgreen bg-green' : 'bg-amber')} />
      {ok ? label : status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
    </span>
  );
}

/** Time-stamped plain lines, newest on top, sliding in from the right. */
export function LiveFeed({ lines, max = 14, className }: { lines: FeedLine[]; max?: number; className?: string }) {
  const reduce = prefersReducedMotion();
  if (!lines.length) return <div className={clsx('card', className)}><EmptyState title="All quiet for now." hint="New photos, voice notes, emails and Zoho checks show up here as they happen." /></div>;
  return (
    <div className={clsx('card overflow-hidden px-4', className)} aria-live="polite">
      <AnimatePresence initial={false}>
        {lines.slice(0, max).map((l) => {
          const body = (
            <div className="flex gap-3 border-b border-rule py-2.5 text-[13px] last:border-0">
              <span className="num w-[58px] shrink-0 text-[12px] text-ink-3">{timeIN(new Date(l.ts).toISOString())}</span>
              <div className="min-w-0">
                <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3">{l.source}</div>
                <div className={clsx('leading-snug', TONE[l.tone])}>{l.text}</div>
              </div>
            </div>
          );
          return (
            <motion.div key={l.id} layout={!reduce} initial={reduce ? false : { opacity: 0, x: 30, height: 0 }} animate={{ opacity: 1, x: 0, height: 'auto' }} exit={{ opacity: 0 }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}>
              {l.case_id ? <Link href={`/case?id=${encodeURIComponent(l.case_id)}`} className="block hover:bg-[#FBF9F3]">{body}</Link> : body}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
