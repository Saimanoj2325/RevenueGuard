'use client';
import clsx from 'clsx';
import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SheetPicker } from '@/components/money/SheetPicker';
import { WaQr } from '@/components/money/WaQr';
import { Card, ErrorState, Skeleton, StatusTag } from '@/components/ui';
import { api } from '@/lib/api';
import { isDemo, setDemo } from '@/lib/config';
import { useLive } from '@/lib/hooks';

const STEPS = [{ k: 'google', t: 'Gmail', d: 'Reads purchase orders only' }, { k: 'whatsapp', t: 'WhatsApp', d: 'Challan photos and voice notes' }, { k: 'sheets', t: 'Delivery sheet', d: 'Tell us which columns mean what' }, { k: 'acct', t: 'Accounting', d: 'Zoho Books or Tally' }];

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
        {!q.data ? (q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : <Skeleton className="h-60" />) : cur === 2 ? <SheetPicker eyebrow="Step 3 of 4" onDone={() => { q.reload(); setStep(3); }} /> : (
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
