'use client';
import clsx from 'clsx';
import { AudioLines, Brain, Cpu, RefreshCw, ShieldCheck, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Card, Skeleton, plainError } from '@/components/ui';
import { api } from '@/lib/api';
import { minsAgo } from '@/lib/format';
import type { AiHealth, AiModelHealth } from '@/lib/v2types';

const ICON: Record<string, any> = { nim: Brain, groq: Zap, ollama: Cpu, laya: ShieldCheck, sarvam: AudioLines };
const WORD: Record<AiModelHealth['status'], { word: string; tone: 'green' | 'amber' | 'red' | 'grey' }> = {
  working: { word: 'Working', tone: 'green' },
  slow: { word: 'Slow', tone: 'amber' },
  down: { word: 'Not working', tone: 'red' },
  not_set_up: { word: 'Not set up', tone: 'grey' },
  demo: { word: 'Demo stand-in', tone: 'grey' },
};
const TXT = { green: 'text-green', amber: 'text-amber', red: 'text-red', grey: 'text-ink-3' };
const DOT = { green: 'bg-green', amber: 'bg-amber', red: 'bg-red', grey: 'bg-rule-2' };

function secs(ms: number | null) {
  if (ms == null) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Live check of every AI model: actually calls each one with a tiny request. Auto re-checks every 60 s. */
export function AiModels() {
  const [d, setD] = useState<AiHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = useCallback(async (force: boolean) => {
    setBusy(true); setErr(null);
    try { setD(await api.aiHealth(force)); } catch (e: any) { setErr(plainError(e?.message)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { run(false); const t = setInterval(() => run(false), 60000); return () => clearInterval(t); }, [run]);

  const reader = d?.reader ? d.models.find((m) => m.name === d.reader) : null;
  return (
    <section className="mt-2">
      <div className="sect">
        <h2>AI models: live check</h2>
        <span className="flex items-center gap-3">
          {d && <span className="text-ink-3">Checked {minsAgo(d.checked_at)}</span>}
          <button className="btn-ghost btn-sm" disabled={busy} onClick={() => run(true)}><RefreshCw size={13} className={clsx(busy && 'animate-spin')} />{busy ? 'Checking…' : 'Check now'}</button>
        </span>
      </div>
      {err && !d ? <Card className="p-4 text-[13.5px] text-red">{err}</Card> : !d ? <Skeleton className="h-[120px]" /> : (
        <>
          <Card className={clsx('mb-3 flex items-center gap-2.5 px-4 py-3 text-[14px] sm:px-5', reader ? '' : 'text-red')}>
            <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', reader ? DOT[WORD[reader.status].tone] : 'bg-red')} />
            <span><b>{d.summary}</b>{reader && d.reader !== 'nim' ? ' The main AI is not answering, so the backup is doing the work.' : ''}</span>
          </Card>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {d.models.map((m) => {
              const w = WORD[m.status] ?? WORD.down;
              const I = ICON[m.name] ?? Brain;
              return (
                <Card key={m.name} className="flex flex-col p-4" data-testid={`ai-${m.name}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-semibold"><I size={16} strokeWidth={1.8} />{m.label}</span>
                    <span className={clsx('inline-flex items-center gap-1.5 text-[12.5px]', TXT[w.tone])}><span className={clsx('h-2 w-2 rounded-full', DOT[w.tone])} />{w.word}</span>
                  </div>
                  <div className="mt-1.5 text-[12.5px] text-ink-3">{m.role}</div>
                  <div className="mt-2 truncate font-mono text-[12px] text-ink-2" title={m.model}>{m.model}</div>
                  <div className="mt-auto pt-2 text-[13px]">
                    {m.error ? <span className={TXT[w.tone === 'grey' ? 'grey' : 'red']}>{m.error}</span>
                      : <span className="text-ink-2">{[m.detail, secs(m.latency_ms)].filter(Boolean).join(' · ')}</span>}
                  </div>
                </Card>
              );
            })}
          </div>
          <p className="mt-2 text-[12.5px] text-ink-3">Each check sends one tiny request (&quot;Reply with OK&quot;, or 1 s of silence for Sarvam). Order for reading messages: NVIDIA → Groq → Ollama. Slow means over 6 s.</p>
        </>
      )}
    </section>
  );
}
