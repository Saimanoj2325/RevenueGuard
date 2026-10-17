'use client';
import clsx from 'clsx';
import { AlertTriangle, Inbox, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';

export function Skeleton({ className, lines }: { className?: string; lines?: number }) {
  if (lines) return <div className={clsx('space-y-2', className)}>{Array.from({ length: lines }).map((_, i) => <div key={i} className="h-9 animate-pulse rounded bg-paper-2" style={{ opacity: 1 - i * 0.12 }} />)}</div>;
  return <div className={clsx('animate-pulse rounded bg-paper-2', className)} />;
}

export function EmptyState({ title, hint, action, icon, className }: { title: ReactNode; hint?: ReactNode; action?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center', className)}>
      <span className="mb-1 text-ink-3">{icon ?? <Inbox size={20} strokeWidth={1.8} />}</span>
      <div className="text-[14px] font-medium text-ink">{title}</div>
      {hint && <div className="max-w-md text-[13px] text-ink-3">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Plain-word error. Never shows a stack trace. */
export function ErrorState({ error, onRetry, className }: { error?: string | null; onRetry?: () => void; className?: string }) {
  const plain = plainError(error);
  return (
    <div className={clsx('flex items-start gap-3 rounded-md border border-red/30 bg-red-bg/50 px-4 py-3 text-[13.5px]', className)} role="alert">
      <AlertTriangle size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-red" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-ink">{plain}</div>
        <div className="text-[12.5px] text-ink-3">Your data is safe. Nothing was billed or sent.</div>
      </div>
      {onRetry && <button className="btn-ghost btn-sm" onClick={onRetry}><RotateCcw size={13} />Try again</button>}
    </div>
  );
}

export function plainError(e?: string | null): string {
  if (!e) return 'Something went wrong.';
  const s = e.toLowerCase();
  if (s.includes('failed to fetch') || s.includes('network')) return 'We could not reach RevenueGuard. Check your internet or try again.';
  if (s.includes('401') || s.includes('not authenticated')) return 'Your session ended. Please sign in again.';
  if (s.includes('role') || s.includes('403')) return 'Your role cannot do this. Ask the owner or a finance approver.';
  if (s.includes('expired')) return 'This approval expired because the proof changed. Please review the new one.';
  if (s.includes('duplicate') || s.includes('already')) return 'This was already done once. Nothing is done twice.';
  if (s.includes('404') || s.includes('not found') || s.includes('no route')) return 'We could not find this. It may have moved.';
  if (e.length > 140 || /at \w+ \(|traceback|\n/i.test(e)) return 'Something went wrong on our side.';
  return e.charAt(0).toUpperCase() + e.slice(1);
}
