'use client';
import clsx from 'clsx';
import type { ReactNode } from 'react';

export type TagTone = 'red' | 'amber' | 'green' | 'grey';
export function StatusTag({ tone = 'grey', children, className, title }: { tone?: TagTone; children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={clsx('tag', `t-${tone}`, className)}>{children}</span>;
}

/** Money-state word -> tone */
export function toneOf(status: string): TagTone {
  if (['not_billed', 'overdue', 'high', 'missing', 'conflict', 'rejected', 'problem', 'down'].includes(status)) return 'red';
  if (['partial', 'needs_check', 'waiting', 'watch', 'draft', 'pending', 'partially_approved', 'slow', 'relogin', 'check'].includes(status)) return 'amber';
  if (['billed', 'paid', 'verified', 'good', 'found', 'approved', 'closed', 'ok', 'sure', 'sent', 'read', 'replied'].includes(status)) return 'green';
  return 'grey';
}
