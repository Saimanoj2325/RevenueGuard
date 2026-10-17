'use client';
import clsx from 'clsx';
import { ArrowRight, Check, FileSpreadsheet } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { WaQr } from '@/components/money/WaQr';
import { Card, ErrorState, Skeleton, StatusTag, plainError } from '@/components/ui';
import { api } from '@/lib/api';
import { isDemo, setDemo } from '@/lib/config';
import { useLive } from '@/lib/hooks';
import type { SheetColumn } from '@/lib/v2types';

const MEANINGS: [string, string][] = [['po_ref', 'PO number'], ['customer', 'Customer'], ['item', 'Item'], ['qty_ordered', 'Ordered quantity'], ['qty_delivered', 'Delivered quantity'], ['qty_pending', 'Pending quantity'], ['delivery_date', 'Delivery date'], ['ignore', 'Ignore']];
const STEPS = [{ k: 'google', t: 'Gmail', d: 'Reads purchase orders only' }, { k: 'whatsapp', t: 'WhatsApp', d: 'Challan photos and voice notes' }, { k: 'sheets', t: 'Delivery sheet', d: 'Tell us which columns mean what' }, { k: 'acct', t: 'Accounting', d: 'Zoho Books or Tally' }];

function SheetStep({ onDone }: { onDone: () => void }) {
  const [id, setId] = useState(isDemo() ? '1YqDispatchRegister2026' : '');
  const [tab, setTab] = useState('Oct');
  const [cols, setCols] = useState<SheetColumn[] | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState<{ title?: string; rows?: number }>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function read() {
    setBusy(true); setErr(null);
    try { const r = await api.proposeMapping(id, tab); setCols(r.columns); setMeta({ title: r.title, rows: r.rows }); setMap(Object.fromEntries(r.columns.map((c) => [c.header, c.meaning]))); }
    catch (e: any) { setErr(plainError(e?.message)); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setErr(null);
    try { await api.saveSheetConfig(id, `${tab}!A1:Z1000`, map); onDone(); } catch (e: any) { setErr(plainError(e?.message)); } finally { setBusy(false); }
  }
  const sample = (m: string) => cols?.find((c) => map[c.header] === m)?.sample.split(',')[0].trim();
  return (
    <div>
      <div className="eyebrow">Step 3 of 4</div>
      <h2 className="mt-1 text-[22px] font-semibold tracking-[-0.015em] sm:text-[26px]">{cols ? 'We read your sheet. Check the columns.' : 'Which sheet has your deliveries?'}</h2>
      {!cols ? (
        <div className="mt-4 max-w-[560px] space-y-3">
          <label className="block text-[13px] text-ink-2">Google Sheet link or ID<input className="input mt-1" value={id} onChange={(e) => setId(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" /></label>
          <label className="block text-[13px] text-ink-2">Tab name<input className="input mt-1 max-w-[200px]" value={tab} onChange={(e) => setTab(e.target.value)} /></label>
          <button className="btn" disabled={!id || busy} onClick={read}>{busy ? 'Reading…' : 'Read my sheet'}</button>
          <p className="text-[12.5px] text-ink-3">We read the header and the first 20 rows, guess each column from its name first, then its values. You confirm.</p>
        </div>
      ) : (
        <>
          <p className="mt-1 text-[14px] text-ink-2"><FileSpreadsheet size={14} className="mr-1 inline" /><b>{meta.title}</b> · tab &quot;{tab}&quot; · {meta.rows} rows. We guessed what each column means from its name and values. Fix any that look wrong.</p>
          <div className="card mt-4 overflow-x-auto">
            <table className="tbl min-w-[640px]">
              <thead><tr><th>Your column</th><th>Sample values</th><th>Means</th><th>Our guess</th></tr></thead>
              <tbody>
                {cols.map((c) => (
                  <tr key={c.header}>
                    <td><span className="mono rounded-sm border border-rule-2 bg-paper px-2 py-0.5 text-[12.5px]">{c.header}</span></td>
                    <td className="text-[13px] text-ink-3">{c.sample}</td>
                    <td><select className={clsx('select max-w-[220px] py-1.5 text-[13.5px]', c.confidence === 'check' && 'border-amber')} value={map[c.header]} onChange={(e) => setMap({ ...map, [c.header]: e.target.value })}>{MEANINGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                    <td>{map[c.header] === 'ignore' ? <span className="text-[13px] text-ink-3">Ignore</span> : <StatusTag tone={c.confidence === 'sure' ? 'green' : 'amber'}>{c.confidence === 'sure' ? 'Sure' : 'Please check'}</StatusTag>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex items-start gap-2 rounded-md border border-green/25 bg-green-bg/70 px-4 py-3 text-[13.5px]"><Check size={15} className="mt-0.5 text-green" /><span><b>Preview with these columns:</b> {[sample('po_ref'), sample('customer'), sample('qty_ordered') && `${sample('qty_ordered')} ordered`, sample('qty_delivered') && `${sample('qty_delivered')} delivered`, sample('qty_pending') && `${sample('qty_pending')} pending`, sample('delivery_date')].filter(Boolean).join(' · ')}</span></div>
          <div className="mt-4 flex flex-wrap gap-2"><button className="btn" disabled={busy} onClick={save}>Looks right, continue</button><button className="btn-ghost" onClick={() => setCols(null)}>Use a different tab</button></div>
        </>
      )}
      {err && <ErrorState error={err} className="mt-3" />}
    </div>
  );
}

export default function SetupPage() {
  const router = useRouter();
  const q = useLive(() => api.connectorsV2(), [], (e) => e.type === 'connector.updated', 200);
  const [step, setStep] = useState<number | null>(null);
  const [qr, setQr] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const c = (n: string) => (q.data ?? []).find((x) => x.name === n);
  const done = [c('google')?.status === 'connected', c('whatsapp')?.status === 'connected', c('sheets')?.status === 'connected' && !!(c('sheets')?.config as any)?.mapping, c('zoho')?.status === 'connected' || c('tally')?.status === 'connected'];
  useEffect(() => { if (q.data && step === null) { const i = done.findIndex((d) => !d); setStep(i === -1 ? 3 : i); } }, [q.data]); // eslint-disable-line
  const cur = step ?? 0;
  async function connect(name: string) {
    setBusy(name);
    try {
      if (isDemo()) { await api.mockConnect(name); setTimeout(() => { q.reload(); setBusy(null); setStep((s) => Math.min(3, (s ?? 0) + 1)); }, 1800); return; }
      if (name === 'google' || name === 'zoho') { window.location.href = api.oauthStartUrl(name as any); return; }
      await api.mockConnect(name); q.reload();
    } catch { setBusy(null); }
    if (!isDemo()) setBusy(null);
  }
  async function sample() {
    if (!isDemo()) { if (confirm('Sample data runs in your browser (demo mode). You will be signed out and can sign in as a demo user. Continue?')) setDemo(true); return; }
    setBusy('sample'); await api.demoReset().catch(() => {}); router.push('/setup/first-day');
  }
  return (
    <div className="grid gap-x-12 gap-y-6 lg:grid-cols-[300px_minmax(0,1fr)]">
      <div>
        <div className="eyebrow">Set up · about 5 minutes</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.015em]">Connect your business</h1>
        {!q.data ? <Skeleton lines={4} className="mt-5" /> : (
          <ol className="mt-5 space-y-5">
            {STEPS.map((s, i) => {
              const sub = i === 0 ? c('google')?.account : i === 1 ? c('whatsapp')?.account : i === 2 ? c('sheets')?.detail : c('zoho')?.account;
              return (
                <li key={s.k}><button className="flex w-full items-start gap-3 text-left" onClick={() => setStep(i)}>
                  <span className={clsx('grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full border text-[12.5px] font-semibold transition-colors', done[i] ? 'border-green bg-green text-white' : cur === i ? 'border-ink bg-ink text-paper' : 'border-rule-2 text-ink-3')}>{done[i] ? <Check size={13} strokeWidth={2.6} /> : i + 1}</span>
                  <span><span className={clsx('block font-medium', !done[i] && cur !== i && 'text-ink-3')}>{s.t}</span><span className="block text-[12.5px] text-ink-3">{done[i] && sub ? sub : s.d}</span></span>
                </button></li>
              );
            })}
          </ol>
        )}
        <Card className="mt-6 p-4">
          <div className="font-semibold">Not ready to connect?</div>
          <p className="mt-1 text-[13px] text-ink-3">Load a sample business and see a case end to end first.</p>
          <button className="mt-2 inline-flex items-center gap-1 font-semibold" disabled={busy === 'sample'} onClick={sample}>Try with sample data <ArrowRight size={14} /></button>
        </Card>
      </div>
      <div className="min-w-0">
        {!q.data ? (q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : <Skeleton className="h-60" />) : cur === 2 ? <SheetStep onDone={() => { q.reload(); setStep(3); }} /> : (
          <div className="max-w-[640px]">
            <div className="eyebrow">Step {cur + 1} of 4</div>
            {cur === 0 && <><h2 className="mt-1 text-[24px] font-semibold">Connect Gmail</h2><p className="mt-1 text-ink-2">We read emails that look like purchase orders. Read-only: we never send from Gmail without your approval.</p>
              <div className="mt-4 flex gap-2">{done[0] ? <StatusTag tone="green">Connected · {c('google')?.account}</StatusTag> : <button className="btn" disabled={!!busy} onClick={() => connect('google')}>{busy === 'google' ? 'Connecting…' : 'Sign in with Google'}</button>}{done[0] && <button className="btn-ghost" onClick={() => setStep(1)}>Next</button>}</div></>}
            {cur === 1 && <><h2 className="mt-1 text-[24px] font-semibold">Link WhatsApp</h2><p className="mt-1 text-ink-2">Use the number your dispatch team sends challans to. Then choose which chats we may read. Nothing else is stored.</p>
              <div className="mt-4 flex flex-wrap gap-2">{done[1] ? <><StatusTag tone="green">Paired · {c('whatsapp')?.account}</StatusTag><Link href="/setup/connections" className="btn-ghost">Choose chats</Link><button className="btn-ghost" onClick={() => setStep(2)}>Next</button></> : <button className="btn" onClick={() => setQr(true)}>Show QR code</button>}</div></>}
            {cur === 3 && <><h2 className="mt-1 text-[24px] font-semibold">Next: accounting</h2><p className="mt-1 text-ink-2">Invoices are created here only after a person approves, then read back to check.</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <button className="card p-4 text-left hover:border-ink-3" onClick={() => connect('zoho')} disabled={!!busy}><div className="flex items-center justify-between font-semibold">Zoho Books {c('zoho')?.status === 'connected' && <StatusTag tone="green">Connected</StatusTag>}</div><p className="mt-1 text-[13px] text-ink-3">Sign in with Zoho. Creates invoices after your approval.</p></button>
                <button className="card p-4 text-left hover:border-ink-3" onClick={() => connect('tally')} disabled={!!busy}><div className="flex items-center justify-between font-semibold">Tally Prime {c('tally')?.status === 'connected' && <StatusTag tone="green">Connected</StatusTag>}</div><p className="mt-1 text-[13px] text-ink-3">Runs a small connector on your Tally PC (port 9000). Creates vouchers after your approval.</p></button>
              </div>
              {done.every(Boolean) && <div className="mt-5 flex items-center gap-3"><StatusTag tone="green">All 4 connected</StatusTag><Link href="/setup/first-day" className="btn">Start my first day <ArrowRight size={14} /></Link></div>}</>}
          </div>
        )}
      </div>
      {qr && <WaQr onClose={() => setQr(false)} onPaired={() => { setQr(false); q.reload(); setStep(2); }} />}
    </div>
  );
}
