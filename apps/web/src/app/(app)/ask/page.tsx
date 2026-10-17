'use client';
import { ArrowUp, Loader2, Mic } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { ErrorState, ProofList, Skeleton, plainError } from '@/components/ui';
import { api } from '@/lib/api';
import { useT } from '@/i18n';
import type { AskAnswer } from '@/lib/v2types';

interface Turn { q: string; a?: AskAnswer; err?: string }
const EXAMPLES: Record<string, string[]> = {
  en: ['Which customers owe me more than ₹1 lakh?', 'What is not billed yet?', 'Who is overdue?', 'What happened with PO-184?'],
  hi: ['किन ग्राहकों पर 1 लाख से ज़्यादा बकाया है?', 'कौन सा बिल नहीं बना?', 'PO-184 का क्या हुआ?'],
  te: ['ఎవరు 1 లక్ష కంటే ఎక్కువ బాకీ ఉన్నారు?', 'ఏవి బిల్ కాలేదు?', 'PO-184 ఏమైంది?'],
};
const cell = (v: string | number, i: number) => (typeof v === 'string' && /records$/.test(v) ? <span className="chip">{v}</span> : i === 0 ? <b>{v}</b> : v);

function Answer({ a }: { a: AskAnswer }) {
  const i = a.answer.indexOf('. ');
  const head = i > 0 ? a.answer.slice(0, i + 1) : a.answer;
  const rest = i > 0 ? a.answer.slice(i + 1) : '';
  return (
    <div className="max-w-[900px]">
      <p className="text-[16px] leading-relaxed sm:text-[17px]"><b>{head}</b>{rest}</p>
      {a.table && (
        <div className="card mt-3 overflow-x-auto">
          <table className="tbl min-w-[560px]">
            <thead><tr>{a.table.columns.map((c, j) => <th key={c} className={j > 0 && j < 4 && /₹/.test(String(a.table!.rows[0]?.[j] ?? '')) ? 'text-right' : ''}>{c}</th>)}</tr></thead>
            <tbody>{a.table.rows.map((r, k) => <tr key={k}>{r.map((v, j) => <td key={j} className={/₹/.test(String(v)) ? 'num text-right' : ''}>{cell(v, j)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {a.note && <p className="mt-2 text-[12.5px] text-ink-3">{a.note}</p>}
      {a.proofs.length > 0 && <div className="mt-2"><ProofList proofs={a.proofs} max={5} /></div>}
      {a.actions.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{a.actions.map((x) => <Link key={x.href + x.label} href={fixHref(x.href)} className="btn-ghost">{x.label}</Link>)}</div>}
    </div>
  );
}

function AskInner() {
  const t = useT();
  const sp = useSearchParams();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const asked = useRef<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const SR: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setQ(''); setBusy(true);
    setTurns((x) => [...x, { q: text }]);
    try { const a = await api.ask(text, t.lang); setTurns((x) => x.map((tt, i) => (i === x.length - 1 ? { ...tt, a } : tt))); }
    catch (e: any) { setTurns((x) => x.map((tt, i) => (i === x.length - 1 ? { ...tt, err: plainError(e?.message) } : tt))); }
    finally { setBusy(false); setTimeout(() => end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 50); }
  }
  useEffect(() => { const s = sp.get('q'); if (s && asked.current !== s) { asked.current = s; ask(s); } }, [sp]); // eslint-disable-line
  function listen() {
    if (!SR) return;
    const r = new SR();
    r.lang = t.lang === 'hi' ? 'hi-IN' : t.lang === 'te' ? 'te-IN' : 'en-IN';
    r.onresult = (e: any) => { const s = e.results[0][0].transcript; setQ(s); };
    r.onend = () => setListening(false);
    setListening(true); r.start();
  }
  return (
    <div className="flex min-h-[calc(100vh-150px)] flex-col">
      <div className="eyebrow">Ask RevenueGuard</div>
      <h1 className="h1 mt-1">{t('ask.title')}</h1>
      <div className="flex-1 space-y-7 pb-6 pt-6">
        {turns.length === 0 && (
          <div>
            <p className="text-[14px] text-ink-2">Every number comes from your records and links to its proof. I only read; billing and messages always go through approval.</p>
            <div className="mt-4 flex flex-wrap gap-2">{(EXAMPLES[t.lang] ?? EXAMPLES.en).map((e) => <button key={e} className="btn-ghost" onClick={() => ask(e)}>{e}</button>)}</div>
          </div>
        )}
        {turns.map((tt, i) => (
          <div key={i} className="space-y-4">
            <div className="flex justify-end"><div className="max-w-[85%] rounded-[14px] rounded-br-sm bg-ink px-4 py-3 text-[14.5px] text-paper">{tt.q}</div></div>
            {tt.a ? <Answer a={tt.a} /> : tt.err ? <ErrorState error={tt.err} onRetry={() => ask(tt.q)} /> : <div className="flex items-center gap-2 text-[13.5px] text-ink-3"><Loader2 size={14} className="animate-spin" />Checking Zoho, the sheet and WhatsApp…</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="sticky bottom-[64px] z-10 sm:bottom-4" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <div className="flex items-center gap-2 rounded border border-rule-2 bg-card px-4 py-3 focus-within:border-ink">
          <input className="min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-ink-3 focus:outline-none" placeholder={t('ask.placeholder')} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Question" />
          {SR && <button type="button" onClick={listen} className={listening ? 'text-red' : 'text-ink-3 hover:text-ink'} aria-label="Speak"><Mic size={17} strokeWidth={1.8} /></button>}
          <button className="btn btn-sm" disabled={!q.trim() || busy} aria-label="Ask"><ArrowUp size={14} /></button>
        </div>
      </form>
    </div>
  );
}
export default function AskPage() { return <Suspense fallback={<Skeleton className="h-40" />}><AskInner /></Suspense>; }

/** Older API builds sent path-style links (/case/RG-1043); the app uses query links (/case?id=RG-1043). */
function fixHref(h: string): string {
  const m = /^\/(case|customers)\/([^/?#]+)$/.exec(h);
  return m ? `/${m[1]}?id=${encodeURIComponent(decodeURIComponent(m[2]))}` : h;
}
