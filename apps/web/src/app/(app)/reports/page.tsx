'use client';
import clsx from 'clsx';
import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Card, ErrorState, PageHead, Skeleton, StatStrip, plainError } from '@/components/ui';
import { api } from '@/lib/api';
import { dateIN, inr } from '@/lib/format';
import { useLive } from '@/lib/hooks';
import { useT } from '@/i18n';

type P = 'this' | 'last' | 'quarter' | 'custom';
const iso = (d: Date) => d.toISOString().slice(0, 10);
function range(p: P, from: string, to: string): [string, string, string] {
  const now = new Date();
  const m0 = new Date(now.getFullYear(), now.getMonth(), 1);
  if (p === 'this') return [iso(m0), iso(now), m0.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })];
  if (p === 'last') { const a = new Date(now.getFullYear(), now.getMonth() - 1, 1); const b = new Date(now.getFullYear(), now.getMonth(), 0); return [iso(a), iso(b), a.toLocaleDateString('en-GB', { month: 'long' })]; }
  if (p === 'quarter') { const q = Math.floor(now.getMonth() / 3); const a = new Date(now.getFullYear(), q * 3, 1); const fy = (now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear()) % 100; return [iso(a), iso(now), `Q${((q + 3) % 4) + 1} FY${fy}`]; }
  return [from, to, 'Custom'];
}
function download(name: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function printTable(title: string, csv: string) {
  const rows = csv.trim().split('\n').map((r) => r.match(/("[^"]*"|[^,]+|(?<=,)(?=,)|^(?=,)|(?<=,)$)/g) ?? []);
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(`<html><head><title>${title}</title><style>body{font-family:'IBM Plex Sans',system-ui,sans-serif;color:#1A1A17;padding:24px}h1{font-size:18px}table{border-collapse:collapse;width:100%;font-size:11px}td,th{border-bottom:1px solid #E3DED1;padding:5px 6px;text-align:left}th{color:#8A877D;font-weight:500}</style></head><body><h1>${title}</h1><p style="color:#55534C;font-size:12px">Demo Manufacturing Pvt Ltd · generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p><table>${rows.map((r, i) => `<tr>${r.map((c) => `<${i ? 'td' : 'th'}>${c.replace(/^"|"$/g, '')}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table></body></html>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
}

export default function ReportsPage() {
  const t = useT();
  const [p, setP] = useState<P>('this');
  const [cf, setCf] = useState(iso(new Date(Date.now() - 30 * 86400e3)));
  const [ct, setCt] = useState(iso(new Date()));
  const [from, to, label] = useMemo(() => range(p, cf, ct), [p, cf, ct]);
  const q = useLive(() => api.reports(from, to), [from, to], (e) => e.type === 'case.updated', 1000);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [share, setShare] = useState(true);
  const r = q.data;
  async function get(kind: string, pdf: boolean, csvToo = !pdf) {
    setBusy(kind); setErr(null);
    try {
      let csv = await api.reportCsv(from, to);
      if (kind === 'unbilled') csv = [csv.split('\n')[0], ...csv.split('\n').filter((l) => l.startsWith('(not billed)'))].join('\n');
      if (kind === 'ageing') csv = [csv.split('\n')[0], ...csv.split('\n').filter((l) => /Overdue/.test(l))].join('\n');
      if (csvToo) download(`revenueguard-${kind}-${from}_to_${to}.csv`, csv);
      if (pdf) printTable(`${kind === 'ca' ? 'Month-end pack' : kind === 'ageing' ? 'Receivables ageing' : 'Report'} · ${label}`, csv);
    } catch (e: any) { setErr(plainError(e?.message)); }
    finally { setBusy(null); }
  }
  async function audit() {
    setBusy('audit'); setErr(null);
    try { const rows = await api.audit(); const csv = ['Time,Actor,Action,Case,Detail', ...rows.map((a) => [a.ts, a.actor, a.action, a.case_id ?? '', `"${String(typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail ?? '')).replace(/"/g, "'")}"`].join(','))].join('\n'); printTable('Audit trail · ' + label, csv); }
    catch (e: any) { setErr(plainError(e?.message)); } finally { setBusy(null); }
  }
  const ageMax = r?.receivables_ageing ? Math.max(1, ...Object.values(r.receivables_ageing)) : 1;
  const recMax = r ? Math.max(1, ...r.recovered_by_month.map((m) => m.amount)) : 1;
  const DL = [
    { k: 'ca', t: 'Month-end pack for CA', d: 'Billed, collected, GST summary (CGST/SGST/IGST), unbilled list', btn: 'Excel + PDF', act: () => get('ca', true, true) },
    { k: 'gst', t: 'GST summary', d: 'Invoice-wise taxable value, CGST, SGST, IGST · ready for GSTR-1 working', btn: 'Excel (CSV)', act: () => get('gst', false) },
    { k: 'unbilled', t: 'Unbilled deliveries', d: 'Every delivery without an invoice, with proof', btn: 'Excel (CSV)', act: () => get('unbilled', false) },
    { k: 'ageing', t: 'Ageing report', d: 'Receivables by 0–30, 31–60, 61–90, 90+ days', btn: 'PDF', act: () => get('ageing', true) },
    { k: 'audit', t: 'Audit trail', d: 'Who approved what, when, and on which evidence', btn: 'PDF', act: audit },
  ];
  return (
    <div>
      <PageHead title={t('reports.title')} sub={t('reports.sub')} />
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {(['this', 'last', 'quarter', 'custom'] as P[]).map((x) => <button key={x} className={clsx('pill', p === x && 'pill-on')} onClick={() => setP(x)}>{range(x, cf, ct)[2]}</button>)}
        {p === 'custom' && <span className="ml-2 flex items-center gap-1.5 text-[13px]"><input type="date" className="input w-auto py-1" value={cf} onChange={(e) => setCf(e.target.value)} />to<input type="date" className="input w-auto py-1" value={ct} onChange={(e) => setCt(e.target.value)} /></span>}
        <span className="ml-auto text-[12.5px] text-ink-3">{dateIN(from)} – {dateIN(to)}</span>
      </div>
      {q.error && !r ? <ErrorState error={q.error} onRetry={q.reload} /> : !r ? <Skeleton className="h-[120px]" /> : (
        <StatStrip size={32} stats={[
          { label: 'Billed', value: r.collections.billed, note: `${r.billed_count ?? '—'} invoices${r.gst_total ? ` · GST ${inr(r.gst_total)}` : ''}` },
          { label: 'Collected', labelTone: 'green', value: r.collections.collected, note: `${r.payments ?? '—'} payments · ${Math.round(r.collections.rate * 100)}% of billed` },
          { label: 'Caught by RevenueGuard', labelTone: 'green', value: r.caught ?? 0, note: `${r.caught_count ?? 0} invoices you would have missed` },
          { label: 'Still open', labelTone: 'red', value: r.still_open ?? 0, note: 'unbilled + unpaid' },
        ]} />
      )}
      {err && <ErrorState error={err} className="mt-3" />}
      <div className="mt-2 grid gap-x-10 xl:grid-cols-2">
        <section>
          <div className="sect"><h2>Download</h2></div>
          <div className="space-y-2.5">
            {DL.map((x) => (
              <Card key={x.k} className="flex flex-wrap items-center justify-between gap-3 p-4 sm:px-5">
                <div className="min-w-0"><div className="font-semibold">{x.t}</div><div className="text-[13px] text-ink-3">{x.d}</div></div>
                <button className="btn-ghost" disabled={busy === x.k} onClick={x.act}><Download size={14} />{busy === x.k ? 'Preparing…' : x.btn}</button>
              </Card>
            ))}
          </div>
        </section>
        <section>
          <div className="sect"><h2>Receivables ageing</h2></div>
          <Card className="space-y-3 p-5">
            {!r ? <Skeleton lines={4} /> : Object.entries(r.receivables_ageing ?? {}).map(([k, v], i) => (
              <div key={k} className="grid grid-cols-[90px_1fr_100px] items-center gap-3 text-[13.5px]">
                <span>{k}</span>
                <div className="h-[18px] bg-paper-2"><div className={clsx('h-full transition-[width] duration-700', i === 0 ? 'bg-ink-2' : i === 1 ? 'bg-amber' : 'bg-red')} style={{ width: `${(v / ageMax) * 100}%` }} /></div>
                <span className="num text-right">{inr(v)}</span>
              </div>
            ))}
          </Card>
          <div className="sect"><h2>Unbilled by age</h2></div>
          <Card className="grid grid-cols-4 gap-px overflow-hidden bg-rule p-0">
            {r && Object.entries(r.unbilled_ageing).map(([k, v]) => <div key={k} className="bg-card p-3.5"><div className="text-[12px] text-ink-3">{k} days</div><div className="num mt-1 font-semibold text-red">{inr(v)}</div></div>)}
          </Card>
          <div className="sect"><h2>Recovered by month</h2></div>
          <Card className="flex h-[170px] items-end gap-4 px-5 pb-3 pt-5">
            {r?.recovered_by_month.map((m) => (
              <div key={m.month} className="flex flex-1 flex-col items-center justify-end gap-1.5 self-stretch">
                <span className="num text-[12px]">{inr(m.amount)}</span>
                <div className="w-full max-w-[70px] bg-green transition-[height] duration-700" style={{ height: `${(m.amount / recMax) * 90}px` }} />
                <span className="text-[12px] text-ink-3">{m.month.slice(0, 3)}</span>
              </div>
            ))}
          </Card>
          <div className="sect"><h2>Share automatically</h2></div>
          <Card className="flex items-center justify-between gap-3 p-5 text-[13.5px]"><span>Email the month-end pack to <b>CA Srinivas</b> on the 2nd of every month.</span><button role="switch" aria-checked={share} aria-label="Share with CA" className="toggle" onClick={() => setShare((v) => !v)}><span /></button></Card>
        </section>
      </div>
    </div>
  );
}
