'use client';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpRight, CheckCircle2, FastForward, Loader2, Play, Power, RotateCcw, SkipForward, Zap } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CaseHeader } from '@/components/case/CaseFile';
import { StateMachine } from '@/components/case/Orchestration';
import { TimelineSpine } from '@/components/case/TimelineSpine';
import { ErrorNote, PageHead, guardMeta } from '@/components/legacy/ui';
import { api } from '@/lib/api';
import { isDemo } from '@/lib/config';
import { clock, factsOf, human, inr } from '@/lib/format';
import { useLive } from '@/lib/hooks';
import { useAuth, useWs } from '@/lib/store';
import { CHAOS, SCENES } from '@/lib/mock/fixtures';

const MAIN = 'RG-1042';
const PKEY = 'rg-demo-progress';

export default function DemoPage() {
  const user = useAuth((s) => s.user);
  const [done, setDone] = useState<number[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kill, setKill] = useState(false);
  const guardrails = useWs((s) => s.guardrails);
  const events = useWs((s) => s.events);

  useEffect(() => {
    try { const p = JSON.parse(localStorage.getItem(PKEY) || '{}'); setDone(p.done ?? []); setKill(!!p.kill); } catch { /* */ }
    // real API: scene progress lives server-side (it also plays skipped scenes first)
    if (!isDemo()) api.demoStatus().then((st) => setDone((st.scenes_done ?? []).filter((n) => n > 0))).catch(() => {});
  }, []);
  const save = (d: number[], k = kill) => { setDone(d); localStorage.setItem(PKEY, JSON.stringify({ done: d, kill: k })); };

  const mini = useLive(() => api.case(MAIN).catch(() => null), [], (e) => ('case_id' in e && e.case_id === MAIN) || e.type === 'approval.updated', 200);
  const next = SCENES.find((s) => s.n > 0 && !done.includes(s.n))?.n ?? null;

  async function act(key: string, fn: () => Promise<any>) {
    setBusy(key); setErr(null);
    try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  }
  const play = (n: number) => act(`scene${n}`, async () => {
    if (n === 0) { await api.demoReset(); save([]); useWs.setState({ guardrails: [] }); setKill(false); await mini.reload(); return; }
    const r = await api.demoStep(n);
    if (!isDemo() && Array.isArray(r?.scenes_done)) save((r.scenes_done as number[]).filter((x) => x > 0));
    else save(Array.from(new Set([...done, ...SCENES.filter((s) => s.n > 0 && s.n <= n).map((s) => s.n)])));
    await mini.reload();
  });

  const agentTicker = events.filter((e) => e.type === 'agent.event').slice(0, 7) as any[];
  const d = mini.data;
  const f = d ? factsOf(d) : null;
  const pending = d?.approvals.find((a) => a.status === 'pending' || a.status === 'partially_approved');

  return (
    <div>
      <PageHead kicker="presenter console" title="Demo control room">
        <button className="btn-ghost" disabled={!!busy} onClick={() => play(0)}>{busy === 'scene0' ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}Reset</button>
        <button className="btn-ghost" disabled={!!busy} onClick={() => act('ff', () => api.fastForward(72))} title="POST /demo/fast-forward {hours:72}"><FastForward size={14} />+72h</button>
        <button
          className={clsx('btn border', kill ? 'border-red bg-red text-ink' : 'border-rule text-ink-2 hover:border-red hover:text-[#B23A26]')}
          disabled={!!busy}
          onClick={() => act('kill', async () => { await api.killSwitch(!kill); setKill(!kill); localStorage.setItem(PKEY, JSON.stringify({ done, kill: !kill })); })}
          aria-pressed={kill}
        ><Power size={14} />Kill switch {kill ? 'ON' : 'off'}</button>
      </PageHead>
      {user?.role !== 'admin' && <div className="mb-3 text-[12.5px] text-[#9A6A12]">Demo controls need admin or operator; the kill switch needs admin. Scenes act as the right seeded user (scene 9 as ops, scenes 11 and 14 as finance).</div>}
      <div className="mb-3"><ErrorNote error={err} /></div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        {/* left: stepper + chaos */}
        <div className="space-y-5">
          <section className="panel">
            <div className="panel-h">
              <span className="panel-t">Story · PO-184 → RG-1042</span>
              <button className="btn-primary" disabled={next === null || !!busy} onClick={() => next !== null && play(next)}>
                {busy?.startsWith('scene') && busy !== 'scene0' ? <Loader2 size={14} className="animate-spin" /> : <SkipForward size={14} />}
                {next === null ? 'Story complete' : `Play scene ${next}`}
              </button>
            </div>
            <ol className="grid gap-px bg-rule sm:grid-cols-2">
              {SCENES.map((s) => {
                const isDone = done.includes(s.n);
                const isNext = s.n === next;
                return (
                  <li key={s.n} className={clsx('relative flex gap-3 bg-card p-3 transition', isNext && 'bg-card')}>
                    {isNext && <motion.span layoutId="scene-next" className="absolute inset-y-0 left-0 w-[3px] bg-red" />}
                    <span className={clsx('num grid h-9 w-9 shrink-0 place-items-center rounded-md border text-[15px] font-semibold', isDone ? 'border-paper bg-paper text-ink' : isNext ? 'border-red text-red' : 'border-rule text-ink-3')}>
                      {isDone ? <CheckCircle2 size={16} /> : s.n}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className={clsx('text-[13.5px] font-semibold', isDone ? 'text-ink-2' : 'text-ink')}>{s.title}</span>
                        <button className="rounded p-1 text-ink-3 hover:bg-paper-2 hover:text-ink" disabled={!!busy} onClick={() => play(s.n)} aria-label={`Play scene ${s.n}`} title={s.n === 0 ? 'POST /demo/reset' : `POST /demo/step/${s.n}`}>
                          {busy === `scene${s.n}` ? <Loader2 size={14} className="animate-spin" /> : s.n === 0 ? <RotateCcw size={14} /> : <Play size={14} />}
                        </button>
                      </div>
                      <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{s.blurb}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="px-4 py-2 text-[11px] text-ink-3">Jumping ahead plays earlier scenes quickly first{isDemo() ? ' (mock backend)' : ''}. Scenes inject fixtures through the same intake path as real data.</div>
          </section>

          <section className="panel">
            <div className="panel-h"><span className="panel-t flex items-center gap-2"><Zap size={15} className="text-red" />Chaos panel</span><span className="num text-[10px] text-ink-3">POST /demo/chaos/&#123;kind&#125;</span></div>
            <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-4">
              {CHAOS.map((c) => (
                <button key={c.kind} disabled={!!busy} onClick={() => act(c.kind, async () => { await api.demoChaos(c.kind); const s = c.kind === 'injection_email' ? 8 : c.kind === 'correction_whatsapp' ? 10 : 0; if (s && !done.includes(s)) save([...done, s]); })}
                  className="group rounded-md border border-rule bg-card px-3 py-2.5 text-left transition hover:border-red/70 hover:bg-red/5 disabled:opacity-50">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-semibold text-ink">{c.label}</span>
                    {busy === c.kind && <Loader2 size={13} className="animate-spin text-red" />}
                  </div>
                  <div className="mt-0.5 text-[11.5px] leading-snug text-ink-3 group-hover:text-ink-2">{c.hint}</div>
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* right: live mini case + guardrail feed */}
        <div className="space-y-4">
          {d ? (
            <>
              <div className="relative">
                <CaseHeader d={d} compact />
                <Link href={`/advanced/case?id=${MAIN}`} className="absolute right-3 top-3 hidden items-center gap-1 rounded bg-ink px-2 py-1 text-[11px] text-paper hover:bg-black sm:inline-flex">open case file <ArrowUpRight size={11} /></Link>
              </div>
              <TimelineSpine timeline={d.timeline} />
              <StateMachine detail={d} />
              <div className="grid gap-3 sm:grid-cols-3">
                <Mini label="billable (validator)" value={f ? inr(f.billable_amount) : '—'} sub={f ? `${f.billable_qty} × ${inr(f.rate)}` : 'not validated'} />
                <Mini label="proposal" value={d.proposal ? inr(d.proposal.action.amount) : '—'} sub={d.proposal ? `v${d.proposal.version ?? 1} · risk ${d.proposal.risk}` : 'none yet'} />
                <Mini label="approval" value={pending ? human(pending.status) : d.approvals[0] ? human(d.approvals.at(-1)!.status) : '—'} sub={d.verification ? `verifier ${d.verification.status}` : `evidence v${d.case.evidence_version}`} />
              </div>
            </>
          ) : (
            <div className="panel grid place-items-center px-6 py-16 text-center">
              <div className="serif text-xl text-[#1A1A17]">RG-1042 isn’t open yet</div>
              <div className="mt-1 text-sm text-ink-3">Play scene 1 — the order email arrives and triage opens the case.</div>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="panel">
              <div className="panel-h"><span className="panel-t">Guardrail feed</span><span className="num text-[10px] text-ink-3">ws · guardrail</span></div>
              <ul className="max-h-[300px] overflow-auto px-3 py-1.5">
                {guardrails.length === 0 && <li className="py-6 text-center text-[12.5px] text-ink-3">Fire some chaos — blocks show up here.</li>}
                <AnimatePresence initial={false}>
                  {guardrails.map((g) => {
                    const m = guardMeta(g.kind);
                    return (
                      <motion.li key={g.id} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="flex gap-2 border-b border-rule py-2 last:border-0">
                        <m.Icon size={14} style={{ color: m.color }} className="mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <div className="num text-[10.5px] uppercase tracking-wider" style={{ color: m.color }}>{m.label} · {clock(new Date(g.ts).toISOString())}</div>
                          <div className="text-[12px] leading-snug text-ink-2">{g.detail}</div>
                        </div>
                      </motion.li>
                    );
                  })}
                </AnimatePresence>
              </ul>
            </section>
            <section className="panel">
              <div className="panel-h"><span className="panel-t">Agent ticker</span><span className="num text-[10px] text-ink-3">ws · agent.event</span></div>
              <ul className="max-h-[300px] overflow-auto px-3 py-1.5">
                {agentTicker.length === 0 && <li className="py-6 text-center text-[12.5px] text-ink-3">Agents idle.</li>}
                {agentTicker.map((e, i) => (
                  <li key={i} className="border-b border-rule py-1.5 last:border-0">
                    <div className="num text-[10.5px] text-ink-3">{clock(e.event.ts)} · <span className="text-amber">{e.event.agent}</span> · {e.event.type}</div>
                    <div className="truncate text-[12px] text-ink-2">{e.event.data?.title ?? e.event.data?.summary ?? e.event.data?.tool ?? e.event.data?.model ?? e.event.data?.reason ?? ''}</div>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Mini({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="panel px-3 py-2.5">
      <div className="eyebrow">{label}</div>
      <motion.div key={value} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="num mt-0.5 text-[20px] font-semibold capitalize text-[#1A1A17]">{value}</motion.div>
      <div className="num text-[10.5px] text-ink-3">{sub}</div>
    </div>
  );
}
