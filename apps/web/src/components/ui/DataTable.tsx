'use client';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { EmptyState } from './States';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  width?: string | number;
  hideSm?: boolean; // hidden below 640px
}

/** Dense ruled table. Wide tables scroll sideways on phones instead of squashing. */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, empty, className, rowClassName, minWidth = 640 }: {
  columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void; empty?: ReactNode; className?: string;
  rowClassName?: (r: T) => string | undefined; minWidth?: number;
}) {
  if (!rows.length) return <div className={clsx('card', className)}>{empty ?? <EmptyState title="Nothing here right now." />}</div>;
  return (
    <div className={clsx('card overflow-x-auto', className)}>
      <table className="tbl" style={{ minWidth }}>
        <thead>
          <tr>{columns.map((c) => <th key={c.key} style={{ width: c.width }} className={clsx(c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.hideSm && 'hidden sm:table-cell', c.className)}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={clsx(onRowClick && 'cursor-pointer hover:bg-[#FBF9F3]', rowClassName?.(r))}>
              {columns.map((c) => <td key={c.key} className={clsx(c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.hideSm && 'hidden sm:table-cell', c.className)}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
