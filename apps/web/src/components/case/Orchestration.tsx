'use client';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronRight, Cpu, Minus, Wrench } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { clock, human } from '@/lib/format';
import { MAIN_STATES, SIDE_STATES, type AgentEvent, type AgentName, type CaseDetail } from '@/lib/types';
import { ProviderBadge, Stamp } from '@/components/legacy/ui';

const SIDE_HELP: Record<string, string> = {
  PAUSED: 'connector down / evidence incomplete',
  ESCALATED: 'conflict · budget hit · invalid output ×2',
  BLOCKED: 'policy violation',
};

export function StateMachine({ detail }: { detail: CaseDetail }) {
  const cur = detail.case.state;
  const visited = new Set(detail.checkpoints.map((c) => c.state));
  const lastMain = [...detail.checkpoints].reverse().find((c) => (MAIN_STATES as readonly string[]).includes(c.state))?.state;
  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="panel-t">State machine <span className="num ml-2 text-[11px] font-normal text-ink-3">owned by orchestrator code, not the LLM</span></div>
      </div>
      <div className="flex flex-wrap items-center gap-y-3">
        {MAIN_STATES.map((s, i) => {
          const active = s === cur;
          const done = visited.has(s) && !active;
          const ghost = !active && s === lastMain && (SIDE_STATES as readonly string[]).includes(cur);
          return (
            <Fragment key={s}>
              <motion.div layout
                className={clsx('num relative rounded-[4px] border px-2 py-1 text-[10.5px] font-semibold tracking-wider sm:px-2.5 sm:text-[11px]',
                  active ? 'animate-pulsering border-red bg-red text-ink' : done ? 'border-rule bg-paper text-ink' : 'border-rule text-ink-3',
                  ghost && 'ring-2 ring-[#9A6A12]/70')}>
                {s.replace('_', ' ')}
                {active && <span className="absolute -top-2 right-1 rounded-sm bg-paper px-1 text-[8.5px] text-red">LIVE</span>}
              </motion.div>
              {i < MAIN_STATES.length - 1 && <ChevronRight size={14} className={clsx('mx-0.5 shrink-0', done || active ? 'text-amber' : 'text-rule-2')} />}
            </Fragment>
          );
        })}
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {SIDE_STATES.map((s) => {
          const active = cur === s;
          const seen = visited.has(s);
          return (
            <div key={s} className={clsx('rounded-md border border-dashed px-3 py-2 transition', active ? 'border-[#9A6A12] bg-[#9A6A12]/10' : 'border-rule')}>
              <div className="flex items-center justify-between">
                <span className={clsx('num text-[11px] font-semibold tracking-wider', active ? (s === 'PAUSED' ? 'text-[#9A6A12]' : 'text-[#B23A26]') : 'text-ink-2')}>{s}</span>
                {active ? <span className="h-2 w-2 animate-pulse rounded-full bg-[#9A6A12]" /> : seen ? <span className="num text-[9.5px] text-ink-3">visited</span> : null}
              </div>
              <div className="mt-0.5 text-[11.5px] text-ink-3">{SIDE_HELP[s]}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Checkpoints({ detail }: { detail: CaseDetail }) {
  const rows = [...detail.checkpoints].reverse();
  return (
    <div className="panel">
      <div className="panel-h"><span className="panel-t">Checkpoints</span><span className="num text-[11px] text-ink-3">{detail.checkpoints.length} rows</span></div>
      <ol className="max-h-[520px] overflow-auto px-2 py-1">
        <AnimatePresence initial={false}>
          {rows.map((c) => (
            <motion.li key={c.seq} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="grid grid-cols-[34px_1fr] gap-2 border-b border-rule px-2 py-2 last:border-0">
              <span className="num text-[12px] text-amber">#{c.seq}</span>
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="num text-[11.5px] font-semibold text-ink">{c.state}</span>
                  <span className="num text-[10px] text-ink-3">{clock(c.ts)}</span>
                </div>
                <div className="num text-[10.5px] text-ink-3">evidence v{c.evidence_version}</div>
                {c.payload?.reason && <div className="mt-0.5 text-[11.5px] leading-snug text-ink-2">{String(c.payload.reason)}</div>}
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
        {rows.length === 0 && <li className="px-2 py-6 text-center text-sm text-ink-3">No checkpoints yet.</li>}
      </ol>
    </div>
  );
}

function Typewriter({ text, animate }: { text: string; animate: boolean }) {
  const [n, setN] = useState(animate ? 0 : text.length);
  useEffect(() => {
    if (!animate) { setN(text.length); return; }
    let i = 0;
    const t = setInterval(() => { i += 2; setN(Math.min(i, text.length)); if (i >= text.length) clearInterval(t); }, 14);
    return () => clearInterval(t);
  }, [text, animate]);
  return <span className={clsx(n < text.length && 'typing-caret')}>{text.slice(0, n)}</span>;
}

interface Step {
  key: string; step: number; title?: string; tool?: string; args?: any; why?: string; result?: string; added?: boolean; ids?: string[];
  model?: { provider: string; model: string; tokens_in: number; latency_ms: number; cost_inr: number }; finished: boolean; invalid?: { raw: string; error: string };
}
interface Run { run_id: string; steps: Step[]; finished?: any; failed?: any; provider?: string; model?: string; startTs: string }

function buildRuns(events: AgentEvent[]): Run[] {
  const runs = new Map<string, Run>();
  for (const e of events) {
    let r = runs.get(e.run_id);
    if (!r) { r = { run_id: e.run_id, steps: [], startTs: e.ts }; runs.set(e.run_id, r); }
    const sn = Number(e.data?.step ?? r.steps.length);
    let st = r.steps.find((s) => s.step === sn);
    if (!st && ['step_started', 'tool_call', 'tool_result', 'model_call', 'step_finished'].includes(e.type)) {
      st = { key: `${e.run_id}:${sn}`, step: sn, finished: false };
      r.steps.push(st);
    }
    switch (e.type) {
      case 'step_started': st!.title = e.data.title; break;
      case 'model_call': st!.model = e.data as any; r.provider = e.data.provider; r.model = e.data.model; break;
      case 'tool_call': st!.tool = e.data.tool; st!.args = e.data.args; st!.why = e.data.why; break;
      case 'tool_result': st!.result = e.data.summary; st!.added = e.data.added_evidence ?? (e.data.evidence_node_ids?.length > 0); st!.ids = e.data.evidence_node_ids; break;
      case 'step_finished': st!.finished = true; if (e.data.invalid_output) st!.invalid = { raw: e.data.raw, error: e.data.error }; break;
      case 'run_finished': r.finished = e.data; break;
      case 'run_failed': r.failed = e.data; break;
    }
  }
  return [...runs.values()];
}

const LANES: { agent: AgentName; title: string; tools: string }[] = [
  { agent: 'triage', title: 'Triage', tools: 'laya_decide · extract_fields · case_attach_or_open' },
  { agent: 'evidence', title: 'Evidence', tools: 'gmail · whatsapp · sheets · drive · zoho · bank · evidence_add' },
  { agent: 'investigation', title: 'Investigation', tools: 'reads + search_alt_ids · credit_notes · compute_billable · rules' },
  { agent: 'resolution', title: 'Resolution', tools: 'draft_action · risk_score · compute_billable' },
];

export function AgentLanes({ trace }: { trace: AgentEvent[] }) {
  const initial = useRef<Set<string> | null>(null);
  const byAgent = useMemo(() => {
    const m: Record<string, Run[]> = {};
    for (const l of LANES) m[l.agent] = buildRuns(trace.filter((e) => e.agent === l.agent));
    return m;
  }, [trace]);
  if (initial.current === null && trace.length >= 0) {
    initial.current = new Set(Object.values(byAgent).flat().flatMap((r) => r.steps.filter((s) => s.finished).map((s) => s.key)));
  }
  return (
    <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
      {LANES.map((l) => {
        const runs = byAgent[l.agent];
        const running = runs.some((r) => !r.finished && !r.failed);
        return (
          <section key={l.agent} className="paper paper-ruled flex min-h-[260px] flex-col" aria-label={`${l.title} agent lane`}>
            <header className="flex items-start justify-between gap-2 border-b border-rule px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="serif text-[17px] font-semibold">{l.title}</span>
                  {running && <span className="h-2 w-2 animate-pulse rounded-full bg-red" aria-label="running" />}
                </div>
                <div className="num truncate text-[9.5px] text-ink-3" title={l.tools}>{l.tools}</div>
              </div>
              <span className="num shrink-0 whitespace-nowrap text-[10px] text-ink-3">{runs.length} run{runs.length === 1 ? '' : 's'}</span>
            </header>
            <div className="flex-1 space-y-3 overflow-auto px-3 py-2.5" style={{ maxHeight: 560 }}>
              {runs.length === 0 && <div className="py-8 text-center text-[12.5px] italic text-ink-3">No notes filed yet.</div>}
              {runs.map((r) => (
                <div key={r.run_id} className="relative">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <span className="num text-[10px] text-ink-3">run {r.run_id.slice(0, 8)} · {clock(r.startTs)}</span>
                    {r.provider && <span className="origin-left scale-90"><ProviderBadge provider={r.provider} model={r.model} onPaper /></span>}
                  </div>
                  <ol className="space-y-2">
                    {r.steps.map((s) => {
                      const fresh = !initial.current!.has(s.key);
                      return (
                        <motion.li key={s.key} initial={fresh ? { opacity: 0, y: 4 } : false} animate={{ opacity: 1, y: 0 }} className="border-l-2 border-rule pl-2.5">
                          <div className="flex items-baseline gap-1.5">
                            <span className="num text-[10px] text-red">{String(s.step).padStart(2, '0')}</span>
                            <span className="text-[12.5px] font-semibold leading-snug">{s.title ?? '…'}</span>
                          </div>
                          {s.tool && (
                            <div className="num mt-0.5 flex items-start gap-1 break-all text-[11px] text-[#55534C]">
                              <Wrench size={11} className="mt-[2px] shrink-0" />
                              <span>{s.tool}({s.args ? Object.entries(s.args).map(([k, v]) => { const t = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v); return `${k}=${t.length > 140 ? t.slice(0, 140) + '…' : t}`; }).join(', ') : ''})</span>
                            </div>
                          )}
                          {s.why && (
                            <div className="serif mt-0.5 text-[12.5px] italic leading-snug text-ink-3">
                              <span className="num not-italic text-[9.5px] uppercase tracking-wider text-ink-3/80">why this check · </span>
                              <Typewriter text={s.why} animate={fresh} />
                            </div>
                          )}
                          {s.result && (
                            <div className="mt-1 flex items-start gap-1.5 text-[12px] leading-snug">
                              {s.added ? <Check size={13} className="mt-[1px] shrink-0 text-[#1E5A3C]" aria-label="added evidence" /> : <Minus size={13} className="mt-[1px] shrink-0 text-ink-3" aria-label="no new evidence" />}
                              <span>{s.result}{s.added && s.ids?.length ? <span className="num ml-1 text-[10px] text-[#1E5A3C]">+{s.ids.length} evidence</span> : null}</span>
                            </div>
                          )}
                          {s.invalid && (
                            <div className="mt-1 rounded-[3px] border border-red/40 bg-red/5 px-1.5 py-1">
                              <div className="num break-all text-[10.5px] text-red">{s.invalid.raw}</div>
                              <div className="text-[11px] text-red">{s.invalid.error}</div>
                            </div>
                          )}
                          {s.model && (
                            <div className="num mt-0.5 flex items-center gap-1 text-[9.5px] text-ink-3">
                              <Cpu size={10} /> {s.model.tokens_in} tok · {s.model.latency_ms}ms · ₹{s.model.cost_inr}
                            </div>
                          )}
                        </motion.li>
                      );
                    })}
                  </ol>
                  {r.finished && <div className="mt-2"><Stamp color="#1E5A3C">filed · schema ✓</Stamp></div>}
                  {r.failed && <div className="mt-2"><Stamp color="#B7281F">{human(r.failed.reason)} · {r.failed.attempts ?? ''} tries</Stamp></div>}
                  {r.finished?.output?.stop_reason && <div className="num mt-1 text-[10.5px] text-ink-3">stop_reason: {r.finished.output.stop_reason}</div>}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
