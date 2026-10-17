'use client';
import clsx from 'clsx';
import {
  Bar, BarChart, CartesianGrid, Legend, PolarAngleAxis, PolarGrid, Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ErrorNote, PageHead, Skeleton } from '@/components/legacy/ui';
import { api } from '@/lib/api';
import { human, pct } from '@/lib/format';
import { useLive } from '@/lib/hooks';

const COLORS: Record<string, string> = { rules_only: '#55534C', fixed_sequence: '#9A6A12', adaptive: '#B23A26' };
const LABEL: Record<string, string> = { rules_only: 'Rules-only', fixed_sequence: 'Fixed-sequence', adaptive: 'Adaptive' };
const num = (...xs: any[]) => { for (const x of xs) if (typeof x === 'number' && !Number.isNaN(x)) return x; return null; };

function normApproaches(ev: any): any[] {
  const a = ev?.approaches ?? ev?.results ?? ev?.baselines;
  if (Array.isArray(a)) return a.map((x) => ({ ...x, name: x.name ?? x.approach }));
  if (a && typeof a === 'object') return Object.entries(a).map(([name, v]: any) => ({ name, ...v }));
  return [];
}

const tooltipStyle = { background: '#F5F2EA', border: '1px solid #E3DED1', borderRadius: 6, fontSize: 12, color: '#E6E8EE' };

export default function MetricsPage() {
  const m = useLive(() => api.metrics(), [], (e) => e.type === 'case.updated', 1500);
  const ev = useLive(() => api.evalLatest(), []);
  const s = m.data ?? {};
  const approaches = normApproaches(ev.data);

  const tiles = [
    { k: 'Exception precision', v: pct(num(s.precision, s.exception_precision)), good: true },
    { k: 'Exception recall', v: pct(num(s.recall, s.exception_recall)), good: true },
    { k: 'False-positive rate', v: pct(num(s.fpr, s.false_positive_rate)) },
    { k: 'Evidence coverage', v: pct(num(s.evidence_coverage)), good: true },
    { k: 'Useful next-check', v: pct(num(s.useful_next_check_rate)), good: true },
    { k: 'Verified resolution', v: pct(num(s.verified_resolution_rate, s.verified_resolution)), good: true },
    { k: 'Unsafe writes', v: String(num(s.unsafe_writes) ?? '—'), zero: true },
    { k: 'Duplicate writes', v: String(num(s.duplicate_writes) ?? '—'), zero: true },
    { k: 'Latency p50 / p95', v: `${num(s.latency_p50_s, s.p50_s) ?? '—'}s / ${num(s.latency_p95_s, s.p95_s) ?? '—'}s` },
    { k: 'Cost per case', v: num(s.cost_per_case_inr, s.cost_inr) !== null ? `₹${num(s.cost_per_case_inr, s.cost_inr)!.toFixed(2)}` : '—' },
  ];

  const quality = ['precision', 'recall', 'evidence_coverage', 'useful_next_check_rate', 'verified_resolution_rate'].map((metric) => {
    const row: any = { metric: human(metric).replace(' rate', '') };
    for (const a of approaches) row[a.name] = typeof a[metric] === 'number' ? +(a[metric] * 100).toFixed(1) : 0;
    return row;
  });
  const latency = approaches.map((a) => ({ name: LABEL[a.name] ?? a.label ?? a.name, p50: num(a.p50_s, a.latency_p50_s), p95: num(a.p95_s, a.latency_p95_s), key: a.name }));
  const safety = approaches.map((a) => ({ name: LABEL[a.name] ?? a.name, fpr: +(num(a.fpr) ?? 0) * 100, unsafe: num(a.unsafe_writes) ?? 0, duplicate: num(a.duplicate_writes) ?? 0, cost: num(a.cost_inr, a.cost_per_case_inr) ?? 0 }));
  const scen = (ev.data?.by_scenario ?? []).map((r: any) => ({ ...r, scenario: human(r.scenario) }));

  return (
    <div>
      <PageHead kicker="measured, with denominators" title="Eval & metrics">
        {ev.data && <span className="num text-[11px] text-ink-3">{ev.data.dataset ?? ''} · n={ev.data.n_cases ?? '—'} · {ev.data.run_id ?? ''}</span>}
      </PageHead>
      {(ev.data?.synthetic ?? true) && (
        <div className="mb-4 rounded-md border border-dashed border-amber/50 bg-amber/5 px-3 py-2 text-[12.5px] text-amber">
          Results on a labelled synthetic set — not a claim about live business records. Unsafe and duplicate writes must stay at 0.
        </div>
      )}
      <ErrorNote error={m.error || ev.error} />

      {!m.data ? <Skeleton className="h-32" /> : (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rule bg-rule sm:grid-cols-5">
          {tiles.map((t) => (
            <div key={t.k} className="bg-card px-4 py-3">
              <div className="eyebrow">{t.k}</div>
              <div className={clsx('num mt-1 text-[22px] font-semibold', t.zero ? (t.v === '0' ? 'text-[#1E5A3C]' : 'text-[#B23A26]') : 'text-[#1A1A17]')}>{t.v}</div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <ChartPanel title="Quality by approach (%)" sub="rules-only vs fixed-sequence LLM vs adaptive">
          {approaches.length ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={quality} margin={{ left: -16, right: 8, top: 8 }}>
                <CartesianGrid stroke="#F5F2EA" vertical={false} />
                <XAxis dataKey="metric" tick={{ fill: '#55534C', fontSize: 11 }} interval={0} angle={-12} dy={8} height={48} />
                <YAxis domain={[0, 100]} tick={{ fill: '#55534C', fontSize: 11 }} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(255,255,255,.04)' }} />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => LABEL[v] ?? v} />
                {approaches.map((a) => <Bar key={a.name} dataKey={a.name} fill={COLORS[a.name] ?? '#55534C'} radius={[2, 2, 0, 0]} />)}
              </BarChart>
            </ResponsiveContainer>
          ) : <Skeleton className="h-[300px]" />}
        </ChartPanel>

        <ChartPanel title="Profile" sub="adaptive should dominate without trading off safety">
          {approaches.length ? (
            <ResponsiveContainer width="100%" height={300}>
              <RadarChart data={quality} outerRadius="72%">
                <PolarGrid stroke="#E3DED1" />
                <PolarAngleAxis dataKey="metric" tick={{ fill: '#55534C', fontSize: 10.5 }} />
                {approaches.map((a) => <Radar key={a.name} dataKey={a.name} stroke={COLORS[a.name] ?? '#55534C'} fill={COLORS[a.name] ?? '#55534C'} fillOpacity={a.name === 'adaptive' ? 0.25 : 0.06} />)}
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => LABEL[v] ?? v} />
                <Tooltip contentStyle={tooltipStyle} />
              </RadarChart>
            </ResponsiveContainer>
          ) : <Skeleton className="h-[300px]" />}
        </ChartPanel>

        <ChartPanel title="Case latency (s)" sub="p50 / p95 end-to-end">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={latency} layout="vertical" margin={{ left: 24, right: 16 }}>
              <CartesianGrid stroke="#F5F2EA" horizontal={false} />
              <XAxis type="number" tick={{ fill: '#55534C', fontSize: 11 }} />
              <YAxis type="category" dataKey="name" tick={{ fill: '#55534C', fontSize: 11 }} width={100} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(255,255,255,.04)' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="p50" fill="#9A6A12" radius={[0, 2, 2, 0]} />
              <Bar dataKey="p95" fill="#B23A26" radius={[0, 2, 2, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartPanel>

        <ChartPanel title="Safety & cost" sub="FPR %, unsafe / duplicate writes (count), model+tool cost per case">
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[420px] text-[12.5px]">
              <thead><tr className="text-left">{['approach', 'FPR', 'unsafe', 'duplicate', 'cost/case'].map((h) => <th key={h} className="eyebrow py-2 font-normal">{h}</th>)}</tr></thead>
              <tbody>
                {safety.map((r) => (
                  <tr key={r.name} className="border-t border-rule">
                    <td className="py-2 text-ink">{r.name}</td>
                    <td>{r.fpr.toFixed(1)}%</td>
                    <td className={r.unsafe ? 'text-[#B23A26]' : 'text-[#1E5A3C]'}>{r.unsafe}</td>
                    <td className={r.duplicate ? 'text-[#B23A26]' : 'text-[#1E5A3C]'}>{r.duplicate}</td>
                    <td>₹{r.cost.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartPanel>

        {scen.length > 0 && (
          <ChartPanel title="Correct outcome by scenario" sub="share of cases resolved correctly, per labelled scenario" wide>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={scen} margin={{ left: -16, right: 8, top: 8 }}>
                <CartesianGrid stroke="#F5F2EA" vertical={false} />
                <XAxis dataKey="scenario" tick={{ fill: '#55534C', fontSize: 10.5 }} interval={0} angle={-20} dy={10} height={60} />
                <YAxis domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fill: '#55534C', fontSize: 11 }} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => `${Math.round(v * 100)}%`} cursor={{ fill: 'rgba(255,255,255,.04)' }} />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => LABEL[v] ?? v} />
                {['rules_only', 'fixed_sequence', 'adaptive'].map((k) => <Bar key={k} dataKey={k} fill={COLORS[k]} radius={[2, 2, 0, 0]} />)}
              </BarChart>
            </ResponsiveContainer>
          </ChartPanel>
        )}
      </div>
    </div>
  );
}

function ChartPanel({ title, sub, children, wide }: { title: string; sub?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={clsx('panel', wide && 'xl:col-span-2')}>
      <div className="panel-h"><span className="panel-t">{title}</span>{sub && <span className="hidden text-[11.5px] text-ink-3 sm:block">{sub}</span>}</div>
      <div className="p-3">{children}</div>
    </section>
  );
}
