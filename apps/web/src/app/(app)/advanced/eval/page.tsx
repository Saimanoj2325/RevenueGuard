'use client';
import { useState } from 'react';
import { Card, EmptyState, PageHead, Skeleton, StatStrip, plainError } from '@/components/ui';
import { api } from '@/lib/api';
import { useLive } from '@/lib/hooks';
import { useDemo } from '@/lib/store';

const CHAOS = [
  { kind: 'nim_down', t: 'NIM down', d: 'Falls back to Groq, then Ollama', ms: 30000 },
  { kind: 'zoho_down', t: 'Zoho down', d: 'Waits and retries · no double invoice', ms: 6500 },
  { kind: 'kill_worker', t: 'Kill worker mid-case', d: 'Resumes from last checkpoint', ms: 3500 },
  { kind: 'garbage_output', t: 'Garbage model output', d: 'Rejected by schema, retried, then sent to a person', ms: 4000 },
  { kind: 'correction_whatsapp', t: 'Evidence changes after approval', d: 'Approval expires, asks again', ms: 8000 },
  { kind: 'injection_email', t: 'Prompt injection email', d: 'Kept aside as data; changes nothing', ms: 2500 },
  { kind: 'double_approve', t: 'Double approve', d: 'Second write refused by idempotency key', ms: 1500 },
];
const pct = (v: number | null | undefined) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const label = (s: string) => s.replace(/_/g, ' ').replace(/^./, (m) => m.toUpperCase());

export default function EvalPage() {
  const demo = useDemo();
  const q = useLive(() => api.evalLatest().catch((e) => ({ __err: e?.message ?? String(e) }) as any), []);
  const [run, setRun] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const e: any = q.data;
  const ready = e && !e.__err && Array.isArray(e.approaches) && e.approaches.length;
  const ad = ready ? e.approaches.find((a: any) => a.name === 'adaptive') ?? e.approaches.at(-1) : null;
  const rules = ready ? e.approaches.find((a: any) => a.name === 'rules_only') : null;
  const n = e?.n_cases ?? 0;
  async function chaos(c: (typeof CHAOS)[number]) {
    setMsg(null); setRun((r) => ({ ...r, [c.kind]: true }));
    try { await api.demoChaos(c.kind); } catch (x: any) { setMsg(plainError(x?.message)); }
    setTimeout(() => setRun((r) => ({ ...r, [c.kind]: false })), c.ms);
  }
  return (
    <div>
      <PageHead title="Eval & chaos" sub="Advanced · how well it works, and what happens when things break." />
      {!q.data ? <Skeleton className="h-[120px]" /> : !ready ? (
        <Card><EmptyState title="Not run yet" hint={<>No evaluation results found. Run <span className="mono">python -m eval.run</span> in the repo; the numbers appear here.</>} /></Card>
      ) : (
        <>
          <StatStrip size={34} stats={[
            { label: 'Cases correct', labelTone: 'green', text: `${Math.round((ad.outcome_accuracy ?? 0) * n)} / ${n}`, note: `${pct(ad.outcome_accuracy)} · rules only: ${pct(rules?.outcome_accuracy)}` },
            { label: 'Unsafe writes', labelTone: 'green', text: String(ad.unsafe_writes ?? 0), note: `rules only: ${rules?.unsafe_writes ?? 'n/a'}` },
            { label: 'Duplicate writes', labelTone: 'green', text: String(ad.duplicate_writes ?? 0), note: `rules only: ${rules?.duplicate_writes ?? 'n/a'}` },
            { label: 'Median time', labelTone: 'ink', text: ad.p50_s != null ? `${ad.p50_s} s` : 'n/a', note: `p95 ${ad.p95_s ?? 'n/a'} s · ${ad.tool_calls_per_case ?? '—'} tool calls a case` },
          ]} />
          <p className="mt-2 text-[12.5px] text-ink-3">From eval/results/latest.json · {e.dataset} · generated {String(e.generated_at ?? e.run_id ?? '')}. Synthetic cases with known answers; measured on this suite only, not on live business data.</p>
        </>
      )}
      <div className="mt-2 grid gap-x-10 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="min-w-0">
          <div className="sect"><h2>By case type</h2></div>
          {ready ? (
            <Card className="overflow-x-auto">
              <table className="tbl min-w-[560px]">
                <thead><tr><th>Type</th><th className="text-right">Cases</th><th className="text-right">Adaptive</th><th className="text-right">Fixed sequence</th><th className="text-right">Rules only</th></tr></thead>
                <tbody>{e.by_scenario.map((s: any) => (
                  <tr key={s.scenario}><td>{label(s.scenario)}</td><td className="num text-right">{s.n ?? '—'}</td><td className="num text-right font-semibold">{Math.round((s.adaptive ?? 0) * (s.n ?? 0))}</td><td className="num text-right">{Math.round((s.fixed_sequence ?? 0) * (s.n ?? 0))}</td><td className={`num text-right ${(s.rules_only ?? 0) < 1 ? 'text-red' : ''}`}>{Math.round((s.rules_only ?? 0) * (s.n ?? 0))}</td></tr>
                ))}</tbody>
              </table>
            </Card>
          ) : <Card><EmptyState title="Not run yet" /></Card>}
          {ready && (
            <>
              <div className="sect"><h2>Approaches compared</h2></div>
              <Card className="overflow-x-auto">
                <table className="tbl min-w-[560px]">
                  <thead><tr><th>Metric</th>{e.approaches.map((a: any) => <th key={a.name} className="text-right">{label(a.name)}</th>)}</tr></thead>
                  <tbody>
                    {[['Exception precision', 'precision'], ['Exception recall', 'recall'], ['False positive rate', 'fpr'], ['Evidence coverage', 'evidence_coverage'], ['Useful next check', 'useful_next_check_rate'], ['Verified resolution', 'verified_resolution_rate']].map(([l, k]) => (
                      <tr key={k}><td>{l}</td>{e.approaches.map((a: any) => <td key={a.name} className="num text-right">{pct(a[k])}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </>
          )}
        </section>
        <aside>
          <div className="sect"><h2>Chaos panel</h2><span>demo mode only</span></div>
          <Card className="px-5">
            {!demo && <div className="border-b border-rule py-3 text-[13px] text-amber">Chaos buttons only work in demo mode, so nothing real can be broken. Turn on Demo in the top bar.</div>}
            {CHAOS.map((c) => (
              <div key={c.kind} className="flex items-center justify-between gap-3 border-b border-rule py-3.5 last:border-0">
                <div><div className="font-semibold">{c.t}</div><div className="text-[13px] text-ink-3">{c.d}</div></div>
                <button className={run[c.kind] ? 'btn' : 'btn-ghost'} disabled={!demo || run[c.kind]} onClick={() => chaos(c)}>{run[c.kind] ? 'Running' : 'Break it'}</button>
              </div>
            ))}
          </Card>
          {msg && <p className="mt-2 text-[13px] text-red">{msg}</p>}
          <p className="mt-2 text-[12.5px] text-ink-3">Watch the result on Today&apos;s live feed, the case page and the Audit log.</p>
        </aside>
      </div>
    </div>
  );
}
