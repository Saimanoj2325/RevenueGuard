'use client';
import clsx from 'clsx';
import { BookOpen, FileSpreadsheet, Landmark, Loader2, Mail, MessageCircle, QrCode, Unplug, Upload, ScanLine } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ErrorNote, PageHead, Skeleton } from '@/components/legacy/ui';
import { api } from '@/lib/api';
import { isDemo } from '@/lib/config';
import { ago, human } from '@/lib/format';
import { useLive, useNow } from '@/lib/hooks';
import { useWs } from '@/lib/store';
import type { Connector } from '@/lib/types';

function Pill({ status }: { status: string }) {
  const tone = status === 'connected' || status === 'open' ? 'border-green/50 text-[#1E5A3C] bg-green/10'
    : status === 'degraded' || status === 'error' ? 'border-red/60 text-[#B23A26] bg-red/10'
      : status === 'pairing' || status === 'qr' || status === 'connecting' ? 'border-[#9A6A12]/50 text-[#9A6A12] bg-[#9A6A12]/10'
        : 'border-rule text-ink-3';
  return <span className={clsx('chip', tone)}><span className={clsx('h-1.5 w-1.5 rounded-full bg-current', (status === 'pairing' || status === 'connecting') && 'animate-pulse')} />{human(status)}</span>;
}

function Card({ c, icon, title, sub, children, onRevoke }: { c?: Connector; icon: ReactNode; title: string; sub: string; children?: ReactNode; onRevoke?: () => Promise<void> }) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  return (
    <section className="panel flex flex-col">
      <div className="flex items-start gap-3 border-b border-rule px-4 py-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-paper">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h2 className="serif text-[17px] text-[#1A1A17]">{title}</h2>{c && <Pill status={c.status} />}</div>
          <div className="text-[12px] text-ink-3">{sub}</div>
        </div>
      </div>
      <div className="flex-1 space-y-3 px-4 py-3">
        {c && (
          <dl className="num grid grid-cols-[84px_1fr] gap-y-0.5 text-[11.5px]">
            {c.account && (<><dt className="text-ink-3">account</dt><dd className="truncate text-ink-2">{c.account}</dd></>)}
            {c.detail && (<><dt className="text-ink-3">detail</dt><dd className="text-ink-2">{c.detail}</dd></>)}
            {c.last_sync && (<><dt className="text-ink-3">last sync</dt><dd className="text-ink-2">{ago(c.last_sync, now)}</dd></>)}
            {c.scopes?.length ? (<><dt className="text-ink-3">scopes</dt><dd className="text-ink-2">{c.scopes.join(' · ')}</dd></>) : null}
          </dl>
        )}
        {children}
      </div>
      {onRevoke && c && c.status !== 'disconnected' && (
        <div className="border-t border-rule px-4 py-2.5">
          <button className="btn-ghost text-[12.5px] hover:border-red hover:text-[#B23A26]" disabled={busy} onClick={async () => { setBusy(true); try { await onRevoke(); } finally { setBusy(false); } }}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Unplug size={13} />}Revoke access
          </button>
        </div>
      )}
    </section>
  );
}

export default function ConnectorsPage() {
  const q = useLive(() => api.connectors(), [], (e) => e.type === 'connector.updated', 150);
  const [err, setErr] = useState<string | null>(null);
  const by = Object.fromEntries((q.data ?? []).map((c) => [c.name, c])) as Record<string, Connector>;
  const wrap = (fn: () => Promise<any>) => async () => { setErr(null); try { await fn(); await q.reload(); } catch (e: any) { setErr(e.message); } };
  // DEMO_MODE API (connector rows in mode "mock") or the static mock build: connect with the demo adapter, no OAuth
  const demo = isDemo() || (q.data ?? []).some((c) => (c as any).mode === 'mock');
  const oauth = (name: 'google' | 'zoho') => (demo ? wrap(() => api.mockConnect(name))() : (window.location.href = api.oauthStartUrl(name)));

  if (!q.data) return <div><PageHead kicker="sources" title="Connectors" /><div className="grid gap-4 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-56" />)}</div></div>;

  return (
    <div>
      <PageHead kicker="sources of truth" title="Connectors" />
      <p className="-mt-2 mb-4 max-w-2xl text-[13px] text-ink-3">Least-privilege, revocable access. Agents only read; writes go through the approval-bound gateway.</p>
      <div className="mb-3"><ErrorNote error={err} /></div>
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        <Card c={by.google} icon={<Mail size={18} className="text-[#B23A26]" />} title="Google Workspace" sub="Gmail · Sheets · Drive (OAuth)" onRevoke={wrap(() => api.revoke('google'))}>
          <button className="btn-paper" onClick={() => oauth('google')}>{by.google?.status === 'connected' ? 'Re-authorise Google' : 'Connect Google Workspace'}</button>
          <div className="text-[11.5px] text-ink-3">Redirects to <span className="num">/connectors/google/start</span>; scopes gmail.readonly, gmail.send, spreadsheets.readonly, drive.readonly.</div>
        </Card>
        <WhatsAppCard c={by.whatsapp} onRevoke={wrap(() => api.revoke('whatsapp'))} reload={q.reload} />
        <Card c={by.zoho} icon={<BookOpen size={18} className="text-[#55534C]" />} title="Zoho Books" sub="Sales orders · invoices · payments (ZOHO_DC=in)" onRevoke={wrap(() => api.revoke('zoho'))}>
          <button className="btn-paper" onClick={() => oauth('zoho')}>{by.zoho?.status === 'connected' ? 'Re-authorise Zoho' : 'Connect Zoho Books'}</button>
        </Card>
        <SheetsCard c={by.sheets} onSave={(id, r) => wrap(() => api.sheetsConfig(id, r))()} onRevoke={wrap(() => api.revoke('sheets'))} />
        <BankCard c={by.bank} onUpload={(f) => wrap(() => api.bankUpload(f))()} onRevoke={wrap(() => api.revoke('bank'))} />
      </div>
    </div>
  );
}

function WhatsAppCard({ c, onRevoke, reload }: { c?: Connector; onRevoke: () => Promise<void>; reload: () => void }) {
  const wsQr = useWs((s) => s.waQr);
  const [qr, setQr] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const status = c?.status ?? 'disconnected';

  useEffect(() => { if (wsQr) setQr(wsQr); }, [wsQr]);
  useEffect(() => { if (status === 'pairing') setPairing(true); if (status === 'connected') { setPairing(false); setQr(null); } }, [status]);

  // poll /connectors/whatsapp/qr while pairing (WS wa.qr also pushes rotations)
  useEffect(() => {
    if (!pairing) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await api.whatsappQr();
        if (stop) return;
        if (r.qr) setQr(r.qr);
        setState(r.state ?? null);
        if (r.state === 'open') { setPairing(false); reload(); }
      } catch (e: any) { setErr(e.message); }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [pairing, reload]);

  return (
    <Card c={c} icon={<MessageCircle size={18} className="text-[#1E5A3C]" />} title="WhatsApp" sub="Baileys bridge (unofficial — reviewed for account risk)" onRevoke={onRevoke}>
      {status === 'connected' ? (
        <div className="text-[12.5px] text-[#1E5A3C]">Session open. Messages and media flow into intake; phone numbers are redacted in logs.</div>
      ) : pairing ? (
        <div className="flex flex-wrap items-start gap-4">
          <div className="relative grid h-[176px] w-[176px] place-items-center overflow-hidden rounded-md bg-white p-1.5">
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="WhatsApp pairing QR code" className="h-full w-full" />
            ) : <Loader2 className="animate-spin text-ink" />}
            <span className="pointer-events-none absolute inset-x-0 top-0 h-6 animate-[scan_2.4s_linear_infinite] bg-gradient-to-b from-red/0 via-red/30 to-red/0" />
          </div>
          <div className="min-w-[160px] flex-1 space-y-2 text-[12.5px] text-ink-2">
            <ol className="list-inside list-decimal space-y-0.5">
              <li>Open WhatsApp on the business phone</li>
              <li>Settings → Linked devices → Link a device</li>
              <li>Scan this code (rotates every ~15s)</li>
            </ol>
            <div className="num text-[11px] text-ink-3">bridge state: {state ?? status}</div>
            {(isDemo() || (c as any)?.mode === 'mock') && <button className="btn-paper" onClick={async () => { await api.mockConnect('whatsapp'); }}><ScanLine size={14} />Simulate scan</button>}
          </div>
        </div>
      ) : (
        <button className="btn-paper" onClick={() => { setErr(null); setPairing(true); }}><QrCode size={14} />Pair with QR code</button>
      )}
      <ErrorNote error={err} />
      <style>{`@keyframes scan{0%{transform:translateY(-24px)}100%{transform:translateY(176px)}}`}</style>
    </Card>
  );
}

function SheetsCard({ c, onSave, onRevoke }: { c?: Connector; onSave: (id: string, range: string) => Promise<void>; onRevoke: () => Promise<void> }) {
  const [id, setId] = useState(String(c?.config?.spreadsheet_id ?? ''));
  const [range, setRange] = useState(String(c?.config?.range ?? 'dispatch!A1:F500'));
  const [busy, setBusy] = useState(false);
  return (
    <Card c={c} icon={<FileSpreadsheet size={18} className="text-[#1E5A3C]" />} title="Delivery sheet" sub="Dispatch register in Google Sheets" onRevoke={onRevoke}>
      <form className="space-y-2" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSave(id, range); } finally { setBusy(false); } }}>
        <label className="block"><span className="eyebrow">spreadsheet id</span><input className="input num mt-1" value={id} onChange={(e) => setId(e.target.value)} placeholder="1Yq…" required /></label>
        <label className="block"><span className="eyebrow">range</span><input className="input num mt-1" value={range} onChange={(e) => setRange(e.target.value)} required /></label>
        <button className="btn-paper" disabled={busy}>{busy && <Loader2 size={14} className="animate-spin" />}Save config</button>
      </form>
    </Card>
  );
}

function BankCard({ c, onUpload, onRevoke }: { c?: Connector; onUpload: (f: File) => Promise<void>; onRevoke: () => Promise<void> }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const go = async (f?: File | null) => { if (!f) return; setBusy(true); try { await onUpload(f); } finally { setBusy(false); } };
  return (
    <Card c={c} icon={<Landmark size={18} className="text-[#55534C]" />} title="Bank statement" sub="CSV upload (date, narration, amount, ref)" onRevoke={onRevoke}>
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); go(e.dataTransfer.files?.[0]); }}
        className={clsx('flex flex-col items-center gap-2 rounded-md border border-dashed px-4 py-5 text-center text-[12.5px]', drag ? 'border-amber bg-amber/10' : 'border-rule')}
      >
        <Upload size={18} className="text-ink-3" />
        <span className="text-ink-2">Drop a statement CSV here</span>
        <button className="btn-paper" type="button" disabled={busy} onClick={() => ref.current?.click()}>{busy && <Loader2 size={14} className="animate-spin" />}Choose file</button>
        <input ref={ref} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => go(e.target.files?.[0])} />
      </div>
    </Card>
  );
}
