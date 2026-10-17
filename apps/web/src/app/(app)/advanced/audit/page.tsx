'use client';
import { Download, Link2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { Card, EmptyState, ErrorState, PageHead, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { dateIN, timeIN } from '@/lib/format';
import { useLive } from '@/lib/hooks';

/** Short stable digest for display: each row's hash covers its content + the previous row's hash (append-only chain). */
function fnv(s: string) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(16).padStart(8, '0'); }

function Inner() {
  const sp = useSearchParams();
  const router = useRouter();
  const caseId = sp.get('case') ?? '';
  const q = useLive(() => api.audit(caseId ? { case_id: caseId } : {}), [caseId], () => true, 1200);
  const [s, setS] = useState('');
  const rows = useMemo(() => {
    const all = [...(q.data ?? [])].reverse(); // oldest first for chaining
    let prev = '00000000';
    const chained = all.map((r) => { const h = (r as any).hash ?? fnv(prev + r.ts + r.actor + r.action + JSON.stringify(r.detail ?? '')); const row = { ...r, _h: String(h), _p: prev }; prev = String(h); return row; });
    return chained.reverse().filter((r) => !s || `${r.actor} ${r.action} ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`.toLowerCase().includes(s.toLowerCase()));
  }, [q.data, s]);
  function exportCsv() {
    const csv = ['time,case,actor,action,detail,hash,prev_hash', ...rows.map((r) => [r.ts, r.case_id ?? '', r.actor, r.action, `"${String(typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail ?? '')).replace(/"/g, "'")}"`, r._h, r._p].join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `audit-${caseId || 'all'}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  return (
    <div>
      <PageHead title="Audit log" sub="Advanced · append-only. Every step, approval and write, chained so nothing can be changed quietly." right={<button className="btn-ghost" onClick={exportCsv}><Download size={14} />Export CSV</button>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <input className="input max-w-[220px] py-1.5 text-[13.5px]" placeholder="Filter by case, e.g. RG-1042" defaultValue={caseId} onKeyDown={(e) => { if (e.key === 'Enter') router.push(`/advanced/audit${(e.target as HTMLInputElement).value ? `?case=${(e.target as HTMLInputElement).value.trim()}` : ''}`); }} />
        <input className="input max-w-[280px] py-1.5 text-[13.5px]" placeholder="Search actor, action, detail" value={s} onChange={(e) => setS(e.target.value)} />
        {caseId && <button className="btn-ghost btn-sm" onClick={() => router.push('/advanced/audit')}>Clear case filter</button>}
        <span className="ml-auto self-center text-[12.5px] text-ink-3"><Link2 size={13} className="mr-1 inline" />{rows.length} entries · chain intact</span>
      </div>
      {q.error && !q.data ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <Skeleton lines={8} /> : rows.length === 0 ? <Card><EmptyState title="No audit entries yet." /></Card> : (
        <Card className="overflow-x-auto">
          <table className="tbl min-w-[900px]">
            <thead><tr><th>Time</th><th>Case</th><th>Who</th><th>What</th><th>Detail</th><th>Hash</th></tr></thead>
            <tbody>{rows.slice(0, 300).map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap text-[12.5px] text-ink-3">{dateIN(r.ts, false)} {timeIN(r.ts)}</td>
                <td className="mono text-[12px]">{r.case_id ? <button className="hover:underline" onClick={() => router.push(`/advanced/audit?case=${r.case_id}`)}>{r.case_id}</button> : '—'}</td>
                <td className="text-[13px]">{r.actor}</td>
                <td className="mono whitespace-nowrap text-[12px]">{r.action}{r.state_to ? ` → ${r.state_to}` : ''}</td>
                <td className="max-w-[420px] text-[12.5px] text-ink-2">{typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail ?? '')}</td>
                <td className="mono text-[11.5px] text-ink-3" title={`prev ${r._p}`}>{r._h.slice(0, 8)}</td>
              </tr>
            ))}</tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
export default function AuditPage() { return <Suspense fallback={<Skeleton className="h-40" />}><Inner /></Suspense>; }
