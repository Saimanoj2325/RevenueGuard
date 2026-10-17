'use client';
import { Inbox } from 'lucide-react';
import { useState } from 'react';
import { Card, EmptyState, ErrorState, PageHead, PROOF_ICON, Skeleton, plainError } from '@/components/ui';
import { api } from '@/lib/api';
import { whenIN } from '@/lib/format';
import { useLive } from '@/lib/hooks';
import { useT } from '@/i18n';
import type { UnlinkedItem } from '@/lib/v2types';

function Item({ it, onDone, cases }: { it: UnlinkedItem; onDone: (msg: string) => void; cases: { id: string; label: string }[] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const [pick, setPick] = useState('');
  const Icon = PROOF_ICON[it.source.kind] ?? PROOF_ICON.pdf;
  const best = it.suggestions[0];
  const close = it.suggestions.length > 1 && Math.abs(it.suggestions[0].confidence - it.suggestions[1].confidence) < 0.15;
  async function link(ref: string, po: string) {
    setBusy(true); setErr(null);
    try { await api.linkUnlinked(it.id, ref); onDone(`Attached to ${po}. We'll remember this sender and spelling next time.`); } catch (e: any) { setErr(plainError(e?.message)); } finally { setBusy(false); }
  }
  async function ignore() {
    setBusy(true); setErr(null);
    try { await api.ignoreUnlinked(it.id); onDone('Ignored. It stays in the audit log.'); } catch (e: any) { setErr(plainError(e?.message)); } finally { setBusy(false); }
  }
  return (
    <Card className="p-4 sm:p-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-center">
        <div className="flex min-w-0 gap-4">
          {it.source.kind === 'photo' && <div className="grid h-[88px] w-[88px] shrink-0 place-items-center border border-rule-2 bg-paper-2 text-center text-[12px] text-ink-3">challan<br />photo</div>}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2"><Icon size={15} strokeWidth={1.8} className="text-ink-2" /><b>{it.from}</b><span className="text-[12.5px] text-ink-3">· {whenIN(it.received_at)}</span></div>
            <p className="mt-1.5 text-[13.5px]">{it.preview}</p>
            {(it.extracted.customer || it.extracted.qty) && <div className="mt-1.5 text-[12.5px] text-ink-3">We read: {[it.extracted.customer && `customer "${it.extracted.customer}"`, it.extracted.qty && `${it.extracted.qty} units`, it.extracted.po_ref].filter(Boolean).join(' · ')}</div>}
          </div>
        </div>
        <div>
          {best ? (
            <>
              <div className="text-[12.5px] text-ink-3">Best guess</div>
              <div className="font-semibold">{close ? `${it.suggestions.map((s) => s.po_ref).join(' or ')} · ${best.customer}` : `${best.po_ref} · ${best.customer}`}</div>
              <div className="text-[13px] text-amber">{close ? `Please check: ${it.suggestions.length} open POs for this customer` : `Likely (${Math.round(best.confidence * 100)}%): same customer, item and qty pending`}</div>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {(close ? it.suggestions : [best]).map((s) => <button key={s.case_ref} className="btn" disabled={busy} onClick={() => link(s.case_ref, s.po_ref)}>{close ? s.po_ref : `Attach to ${s.po_ref}`}</button>)}
                <button className="btn-ghost" disabled={busy} onClick={() => setOther((v) => !v)}>Other PO</button>
                <button className="btn-ghost" disabled={busy} onClick={ignore}>Ignore</button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-2"><button className="btn-ghost" onClick={() => setOther(true)}>Link to PO</button><button className="btn-ghost" onClick={ignore}>Ignore</button></div>
          )}
          {other && (
            <div className="mt-2 flex gap-2">
              <select className="select py-1.5 text-[13px]" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Choose an open order…</option>{cases.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
              <button className="btn btn-sm" disabled={!pick || busy} onClick={() => link(pick, cases.find((c) => c.id === pick)?.label.split(' ')[0] ?? pick)}>Link</button>
            </div>
          )}
          {err && <div className="mt-2 text-[12.5px] text-red">{err}</div>}
        </div>
      </div>
    </Card>
  );
}

export default function UnlinkedPage() {
  const t = useT();
  const q = useLive(() => api.unlinked(), [], (e) => e.type === 'case.updated', 400);
  const cs = useLive(() => api.cases().catch(() => []), []);
  const [msg, setMsg] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  const cases = (cs.data ?? []).filter((c) => c.state !== 'CLOSED' && c.reference?.startsWith('PO')).map((c) => ({ id: c.id, label: `${c.reference} · ${c.customer}` }));
  return (
    <div>
      <PageHead title={t('unlinked.title')} sub={t('unlinked.sub')} />
      {q.error && !q.data && <ErrorState error={q.error} onRetry={q.reload} />}
      {!q.data && !q.error && <Skeleton lines={3} />}
      {q.data && (
        <>
          {items.length > 0 && (
            <div className="mb-4 flex items-start gap-3 rounded-md border border-amber/30 bg-amber-bg/70 px-4 py-3 text-[13.5px]">
              <Inbox size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-amber" />
              <span><b>{items.length} waiting.</b> We also replied on WhatsApp asking &quot;Which PO is this for?&quot;. When someone answers there, it is linked by itself.</span>
            </div>
          )}
          {msg && <div className="mb-3 text-[13px] text-green" role="status">{msg}</div>}
          <div className="space-y-3">
            {items.map((it) => <Item key={it.id} it={it} cases={cases} onDone={(m) => { setMsg(m); q.reload(); }} />)}
            {items.length === 0 && <Card><EmptyState title="All sorted. Nothing is unlinked." hint="Photos, voice notes and emails we cannot match to an order land here. Linking one teaches RevenueGuard the sender and spelling." /></Card>}
          </div>
          <div className="sect"><h2>Sorted recently</h2></div>
          {q.data.sorted.length === 0 ? <Card><EmptyState title="Nothing sorted yet." /></Card> : (
            <Card>
              {q.data.sorted.map((s, i) => (
                <div key={i} className="grid gap-1 border-b border-rule px-4 py-3 text-[13.5px] last:border-0 sm:grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)] sm:gap-4 sm:px-5">
                  <span className="text-ink-3">{whenIN(s.at)}</span><span>{s.text}</span><span className="text-ink-3">{s.outcome}</span>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
