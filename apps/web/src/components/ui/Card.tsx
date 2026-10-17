'use client';
import clsx from 'clsx';
import type { ReactNode } from 'react';

export function Card({ children, className, pad = false, as: As = 'div', ...rest }: { children: ReactNode; className?: string; pad?: boolean; as?: any; [k: string]: any }) {
  return <As className={clsx('card', pad && 'p-4 sm:p-5', className)} {...rest}>{children}</As>;
}

/** Section heading row ("Bill these today ......... See all 7") */
export function Section({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="sect"><h2>{title}</h2>{right && <div className="text-[13px] text-ink-2">{right}</div>}</div>
      {children}
    </section>
  );
}

/** Page header: title + subtitle (+ optional right side). The top bar search/lang/avatar lives in the Shell. */
export function PageHead({ title, sub, eyebrow, right }: { title: ReactNode; sub?: ReactNode; eyebrow?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h1 className="h1">{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}
