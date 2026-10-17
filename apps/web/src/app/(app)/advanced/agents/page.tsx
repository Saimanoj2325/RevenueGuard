'use client';
import clsx from 'clsx';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { Card, EmptyState, ErrorState, PageHead, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { timeIN } from '@/lib/format';
import { useLive } from '@/lib/hooks';
import { TimelineSteps } from '@/components/case/TimelineSteps';
import type { AgentEvent, CaseDetail } from '@/lib/types';

const LANES = ['triage', 'evidence', 'investigation', 'resolution', 'timeline'] as const;
interface Block { id: string; agent: string; tool: string; t0: number; t1: number; provider: string | null; tokens: number; why?: string; args?: any; result?: any; ms: number }

/** Lay calls on a compressed clock: idle gaps longer than 4 s shrink to 1.5 s so a story spread over days still reads. */
function build(trace: AgentEvent[]) {
  const evs = [...trace].sort((a, b) => a.ts.localeCompare(b.ts));
  let clock = 0, last: number | null = null;
  const at = new Map<AgentEvent, number>();
  for (const e of evs) { const t = new Date(e.ts).getTime(); if (last !== null) { const g = (t - last) / 1000; clock += g > 4 ? 1.5 : Math.max(0, g); } last = t; at.set(e, clock); }
  const blocks: Block[] = [];
  const prov: Record<string, { p: string; tok: number }> = {};
  const open: Record<string, Block> = {};
  for (const e of evs) {
    if (e.type === 'model_call') prov[e.run_id] = { p: e.data.provider, tok: (e.data.tokens_in ?? 0) + (e.data.tokens_out ?? 0) };
    if (e.type === 'tool_call') {
      const b: Block = { id: `${e.run_id}:${e.data.step}:${blocks.length}`, agent: e.agent, tool: String(e.data.tool), t0: at.get(e)!, t1: at.get(e)! + 0.6, provider: prov[e.run_id]?.p ?? null, tokens: prov[e.run_id]?.tok ?? 0, why: e.data.why, args: e.data.args, ms: 0 };
      blocks.push(b); open[e.run_id] = b;
    }
    if (e.type === 'tool_result' && open[e.run_id] && open[e.run_id].tool === e.data.tool) {
      const b = open[e.run_id]; b.t1 = Math.max(b.t0 + 0.5, at.get(e)!); b.result = e.data.summary ?? e.data; b.ms = Math.round((new Date(e.ts).getTime() - 0) % 1); delete open[e.run_id];
      b.ms = Math.round((b.t1 - b.t0) * 1000);
    }
  }
  const tokens = evs.filter((e) => e.type === 'model_call').reduce((s, e) => s + (e.data.tokens_in ?? 0) + (e.data.tokens_out ?? 0), 0);
  const cost = evs.filter((e) => e.type === 'model_call').reduce((s, e) => s + (e.data.cost_inr ?? 0), 0);
  return { blocks, span: Math.max(clock, 1), tokens, cost, runs: new Set(evs.map((e) => e.run_id)).size, start: evs[0]?.ts };
}
const CODE_TOOLS = /compute_billable|compare_counts|laya|read_delivery|sheets_read|case_attach/;

function Gates({ d }: { d: CaseDetail }) {
  const inj = d.evidence.nodes.filter((n) => n.untrusted_flag).length;
  const apr = d.approvals.at(-1);
  const act = d.actions.at(-1);
  const g: [string, boolean | null][] = [
    [`validator ${d.facts?.check?.amount_matches === false ? '✗' : d.facts ? '✓' : '…'}`, d.facts ? d.facts.check?.amount_matches !== false : null],
    ['policy: no write tools ✓', true],
    [`laya: injection blocked ${inj}`, true],
    [`approval: ${apr?.status ?? 'none'}`, apr ? apr.status === 'approved' : null],
    [`gateway: ${act ? act.status : 'idle'}`, act ? act.status === 'succeeded' : null],
    [`verifier: ${d.verification?.status ?? 'idle'}`, d.verification ? d.verification.status === 'passed' : null],
  ];
  return <div className="flex flex-wrap gap-1.5">{g.map(([t, ok]) => <span key={t} className={clsx('tag', ok === false ? 't-red' : ok ? 't-green' : 't-grey')}>{t}</span>)}</div>;
}

function Inner() {
  const sp = useSearchParams();
  const router = useRouter();
  const cases = useLive(() => api.cases(), []);
  // no ?id: open the newest real case (live mode has no RG-1042 unless the demo story was played)
  const id = sp.get('id') ?? cases.data?.[0]?.id ?? '';
  const tr = useLive(() => (id ? api.trace(id) : Promise.resolve([] as AgentEvent[])), [id], (e: any) => e.case_id === id, 600);
  const det = useLive(() => (id ? api.case(id) : Promise.resolve(null as CaseDetail | null)), [id], (e: any) => e.case_id === id, 600);
  const [sel, setSel] = useState<string | null>(null);
  const m = useMemo(() => build(tr.data ?? []), [tr.data]);
  const b = m.blocks.find((x) => x.id === sel) ?? m.blocks.find((x) => x.tool === 'search_alt_ids') ?? m.blocks[0];
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => Math.round(m.span * k));
  return (
    <div>
      <PageHead title="Agent activity" sub="Advanced · for engineers. How the AI worked on each case." />
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <select className="select w-auto py-1.5 text-[13.5px] font-medium" value={id} onChange={(e) => router.push(`/advanced/agents?id=${e.target.value}`)}>
          {(cases.data?.length ? cases.data : [{ id, reference: '' } as any]).map((c) => <option key={c.id} value={c.id}>Case {c.id} · {c.reference}</option>)}
        </select>
        <span className="text-[13px] text-ink-3">{m.runs} runs{m.start ? ` · started ${timeIN(m.start)}` : ''} · {Math.round(m.span)} s active · {m.blocks.length} tool calls · {m.tokens.toLocaleString('en-IN')} tokens · ₹{m.cost.toFixed(2)}</span>
        <span className="ml-auto flex gap-3 text-[12.5px] text-ink-2"><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-ink" />NIM deepseek-v4.1-flash</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-amber" />Groq fallback</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-ink-3" />code only</span></span>
      </div>
      {cases.data && cases.data.length === 0 ? <Card><EmptyState title="No cases yet." /></Card> : tr.error && !tr.data ? <ErrorState error={tr.error} onRetry={tr.reload} /> : !tr.data ? <Skeleton className="h-[320px]" /> : m.blocks.length === 0 ? <Card><EmptyState title="No agent runs for this case yet." /></Card> : (
        <Card className="overflow-x-auto">
          <div className="min-w-[860px]">
            <div className="grid grid-cols-[150px_1fr] border-b border-rule"><div /><div className="relative h-9">{ticks.map((t, i) => <span key={i} className="absolute top-2.5 -translate-x-1/2 text-[12px] text-ink-3" style={{ left: `${Math.min(97, Math.max(3, i * 25))}%` }}>{t}s</span>)}</div></div>
            {LANES.filter((lane) => lane !== 'timeline' || m.blocks.some((x) => x.agent === 'timeline')).map((lane) => (
              <div key={lane} className="grid grid-cols-[150px_1fr] border-b border-rule">
                <div className="flex items-center px-4 py-5 font-semibold capitalize">{lane}</div>
                <div className="relative h-[64px] border-l border-rule">
                  {m.blocks.filter((x) => x.agent === lane).map((x) => {
                    const code = !x.provider || CODE_TOOLS.test(x.tool);
                    return (
                      <button key={x.id} onClick={() => setSel(x.id)} title={x.tool}
                        className={clsx('absolute top-2.5 h-[44px] overflow-hidden rounded-sm px-2 py-1 text-left text-[11.5px] leading-tight text-paper', code ? 'bg-ink-3' : x.provider === 'groq' ? 'bg-amber' : 'bg-ink', b?.id === x.id && 'outline outline-2 outline-offset-1 outline-ink')}
                        style={{ left: `${(x.t0 / m.span) * 100}%`, width: `max(${((x.t1 - x.t0) / m.span) * 100}%, 64px)` }}>
                        <div className="mono truncate">{x.tool}</div><div className="truncate opacity-80">{code ? '—' : x.provider} · {(x.ms / 1000).toFixed(1)}s</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="grid grid-cols-[150px_1fr]"><div className="flex items-center px-4 py-4 font-semibold">Code gates</div><div className="border-l border-rule px-3 py-3">{det.data && <Gates d={det.data} />}</div></div>
          </div>
        </Card>
      )}
      <TimelineSteps trace={tr.data ?? []} />
      <div className="mt-2 grid gap-x-10 xl:grid-cols-2">
        <section>
          <div className="sect"><h2>Selected call · <span className="mono text-[14px]">{b?.tool ?? '—'}</span></h2><span className="capitalize">{b?.agent} agent</span></div>
          {b ? (
            <Card className="space-y-3 p-5 text-[13.5px]">
              <div><div className="text-ink-3">Why</div><div>{b.why ?? 'No reason recorded.'}</div></div>
              <div><div className="text-ink-3">Input</div><pre className="mono mt-1 whitespace-pre-wrap break-all rounded-sm border border-rule bg-paper p-3 text-[12px]">{JSON.stringify(b.args ?? {}, null, 0)}</pre></div>
              <div><div className="text-ink-3">Output</div><pre className="mono mt-1 whitespace-pre-wrap break-all rounded-sm border border-rule bg-paper p-3 text-[12px]">{typeof b.result === 'string' ? b.result : JSON.stringify(b.result ?? 'still running', null, 0)}</pre></div>
              <div className="text-[12.5px] text-ink-3">Provider: {b.provider ? `${b.provider} · ${b.tokens.toLocaleString('en-IN')} tokens` : 'code only (no model)'} · {(b.ms / 1000).toFixed(1)} s</div>
            </Card>
          ) : <Card><EmptyState title="Pick a call on the timeline." /></Card>}
        </section>
        <section>
          <div className="sect"><h2>State machine</h2><span>checkpoints</span></div>
          <Card>
            {(det.data?.checkpoints ?? []).slice(-12).map((c) => (
              <div key={c.seq} className="grid grid-cols-[90px_190px_1fr] gap-3 border-b border-rule px-4 py-2.5 text-[13px] last:border-0">
                <span className="text-ink-3">{timeIN(c.ts)}</span><span className="mono text-[12.5px]">{c.state}</span><span className="truncate text-ink-3">{String(c.payload?.reason ?? (c.payload?.proposal_id ? `proposal ${c.payload.proposal_id}` : `evidence v${c.evidence_version}`))}</span>
              </div>
            ))}
            {!det.data && <Skeleton lines={5} className="p-3" />}
          </Card>
        </section>
      </div>
    </div>
  );
}
export default function AgentsPage() { return <Suspense fallback={<Skeleton className="h-40" />}><Inner /></Suspense>; }
