'use client';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, Tags } from 'lucide-react';
import { useState } from 'react';
import { Empty, ErrorNote, PageHead, ProbList, Skeleton, SourceIcon } from '@/components/legacy/ui';
import { api } from '@/lib/api';
import { ago, human } from '@/lib/format';
import { useLive, useNow } from '@/lib/hooks';
import { EXCEPTION_TYPES, SEVERITIES, type ExceptionType, type Severity, type TriageItem } from '@/lib/types';

export default function TriagePage() {
  const q = useLive(() => api.triageQueue(), [], (e) => e.type === 'case.updated', 600);
  const now = useNow();
  return (
    <div>
      <PageHead kicker="low-confidence intake" title="Triage review" />
      <p className="-mt-2 mb-4 max-w-2xl text-[13px] text-ink-3">Laya was unsure about these. Your label routes the item and joins the labelled eval set — no model guesses are acted on here.</p>
      <ErrorNote error={q.error} />
      {!q.data ? <Skeleton className="h-48" /> : q.data.length === 0 ? (
        <Empty icon={<Tags className="text-ink-3" />} title="Queue clear" hint="Nothing below the confidence threshold right now." />
      ) : (
        <div className="space-y-3">
          <AnimatePresence initial={false}>
            {q.data.map((t) => <Item key={t.id} t={t} now={now} onDone={() => q.setData((q.data ?? []).filter((x) => x.id !== t.id))} />)}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function Item({ t, now, onDone }: { t: TriageItem; now: number; onDone: () => void }) {
  const [type, setType] = useState<ExceptionType>(t.predicted?.exception_type ?? 'none');
  const [sev, setSev] = useState<Severity>(t.predicted?.severity ?? 'low');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <motion.div layout exit={{ opacity: 0, x: 60 }} className="grid gap-0 overflow-hidden rounded-lg border border-rule md:grid-cols-[1.2fr_1fr_300px]">
      <div className="paper rounded-none p-4">
        <div className="flex items-center gap-2">
          <SourceIcon source={t.source ?? 'gmail'} size={14} />
          <span className="eyebrow">{t.source} · {ago(t.created_at, now)}</span>
          <span className="num ml-auto text-[11px] text-red">conf {(t.confidence ?? 0).toFixed(2)}</span>
        </div>
        <div className="serif mt-1.5 text-[17px] font-medium">{t.title}</div>
        <p className="mt-1 text-[13px] leading-snug text-ink-3">{t.excerpt}</p>
      </div>
      <div className="space-y-3 bg-card p-4">
        {t.laya?.answers && Object.entries(t.laya.answers).map(([k, a]) => (
          <div key={k}>
            <div className="eyebrow mb-1">{human(k)}{t.laya?.fallback ? ' · heuristic fallback' : ''}</div>
            <ProbList probs={a.probs} />
          </div>
        ))}
      </div>
      <form className="space-y-2.5 border-t border-rule bg-card p-4 md:border-l md:border-t-0" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { await api.label(t.id, type, sev); onDone(); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
      }}>
        <label className="block"><span className="eyebrow">exception type</span>
          <select className="input mt-1" value={type} onChange={(e) => setType(e.target.value as ExceptionType)}>{EXCEPTION_TYPES.map((x) => <option key={x} value={x}>{human(x)}</option>)}</select>
        </label>
        <div><span className="eyebrow">severity</span>
          <div className="mt-1 grid grid-cols-4 gap-1">
            {SEVERITIES.map((s) => (
              <button type="button" key={s} onClick={() => setSev(s)} aria-pressed={sev === s}
                className={`num rounded border px-1 py-1 text-[11px] capitalize ${sev === s ? 'border-white bg-white/10 text-ink' : 'border-rule text-ink-3'}`}>{s}</button>
            ))}
          </div>
        </div>
        <ErrorNote error={err} />
        <button className="btn-primary w-full" disabled={busy}>{busy && <Loader2 size={14} className="animate-spin" />}File label</button>
      </form>
    </motion.div>
  );
}
