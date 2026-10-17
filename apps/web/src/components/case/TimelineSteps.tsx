'use client';
// Agent activity: the Timeline agent's steps (tool, short args, result, why), grouped by run.
import clsx from 'clsx';
import { timeIN } from '@/lib/format';
import { timelineSteps } from '@/lib/timeline';
import type { AgentEvent } from '@/lib/types';

export function TimelineSteps({ trace }: { trace: AgentEvent[] }) {
  const steps = timelineSteps(trace);
  if (!steps.length) return null;
  const runs = Array.from(new Set(steps.map((s) => s.run_id)));
  return (
    <section data-testid="timeline-steps">
      <div className="sect"><h2>Timeline agent steps</h2><span>{runs.length} run{runs.length > 1 ? 's' : ''} · {steps.length} tool calls</span></div>
      <div className="space-y-3">
        {runs.map((r, ri) => (
          <div key={r} className="card overflow-x-auto">
            <div className="border-b border-rule px-4 py-2 text-[12.5px] text-ink-3">Run {ri + 1} · started {timeIN(steps.find((s) => s.run_id === r)!.ts)}</div>
            <table className="tbl min-w-[760px] text-[13px]">
              <thead><tr><th className="w-8">#</th><th>Tool</th><th>Input</th><th>Result</th><th>Why</th></tr></thead>
              <tbody>
                {steps.filter((s) => s.run_id === r).map((s, i) => (
                  <tr key={i}>
                    <td className="text-ink-3">{s.step}</td>
                    <td className="mono whitespace-nowrap text-[12.5px]">{s.tool}</td>
                    <td className="mono break-all text-[12px] text-ink-2">{s.args || '—'}</td>
                    <td className={clsx(s.ok === false && 'text-red', s.result == null && 'text-ink-3')}>{s.result ?? 'still running'}</td>
                    <td className="text-ink-2">{s.why ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}
