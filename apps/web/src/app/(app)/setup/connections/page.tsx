'use client';
import clsx from 'clsx';
import { AlertTriangle, FileSpreadsheet, Landmark, Mail, MessageCircle, ReceiptText, RefreshCw, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { WaQr } from '@/components/money/WaQr';
import { Card, EmptyState, ErrorState, PageHead, Skeleton, plainError } from '@/components/ui';
import { api } from '@/lib/api';
import { isDemo } from '@/lib/config';
import { minsAgo } from '@/lib/format';
import { useLive } from '@/lib/hooks';
import { useAuth } from '@/lib/store';
import { useT } from '@/i18n';
import type { ConnectorV2, WaChat } from '@/lib/v2types';

const META: Record<string, { label: string; Icon: any }> = {
  google: { label: 'Gmail', Icon: Mail }, whatsapp: { label: 'WhatsApp', Icon: MessageCircle }, sheets: { label: 'Delivery sheet', Icon: FileSpreadsheet },
  zoho: { label: 'Zoho Books', Icon: ReceiptText }, tally: { label: 'Tally', Icon: ReceiptText }, bank: { label: 'Bank statement', Icon: Landmark },
};
function healthOf(c?: ConnectorV2): { word: string; tone: 'green' | 'amber' | 'red' } {
  if (!c || c.status === 'disconnected') return { word: 'Not finished', tone: 'amber' };
  if (c.health === 'down' || c.status === 'degraded' || c.status === 'error') return { word: 'Down', tone: 'red' };
  if (c.health === 'relogin' || c.status === 'pairing') return { word: 'Needs re-login', tone: 'amber' };
  if (c.health === 'slow') return { word: 'Slow', tone: 'amber' };
  return { word: 'Working', tone: 'green' };
}

function ConnCard({ name, c, onReconnect }: { name: string; c?: ConnectorV2; onReconnect: () => void }) {
  const m = META[name];
  const h = healthOf(c);
  return (
    <Card className="flex flex-col p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2.5 font-semibold"><m.Icon size={17} strokeWidth={1.8} />{m.label}</span>
        <span className={clsx('inline-flex items-center gap-1.5 text-[13px]', h.tone === 'green' ? 'text-green' : h.tone === 'red' ? 'text-red' : 'text-amber')}><span className={clsx('h-2 w-2 rounded-full', h.tone === 'green' ? 'bg-green' : h.tone === 'red' ? 'bg-red' : 'bg-amber')} />{h.word}</span>
      </div>
      <div className="mt-2 text-[13px] text-ink-3">{[c?.account, c?.detail].filter(Boolean).join(' · ') || 'Not connected yet'}</div>
      <div className="mt-1 text-[13.5px]">{c?.error_plain && h.tone !== 'green' ? <span className={h.tone === 'red' ? 'text-red' : 'text-amber'}>{c.error_plain}</span> : c?.last_sync ? `Synced ${minsAgo(c.last_sync)}` : 'Waiting for first sync'}</div>
      {h.tone !== 'green' && <button className="btn-ghost btn-sm mt-3 self-start" onClick={onReconnect}><RefreshCw size={13} />{c?.status === 'disconnected' ? 'Connect' : 'Reconnect'}</button>}
    </Card>
  );
}

export default function ConnectionsPage() {
  const t = useT();
  const user = useAuth((s) => s.user);
  const q = useLive(() => api.connectorsV2(), [], (e) => e.type === 'connector.updated', 200);
  const chats = useLive(() => api.waChats().catch(() => [] as WaChat[]), []);
  const [sel, setSel] = useState<Set<string> | null>(null);
  const [kind, setKind] = useState<'all' | 'group' | 'person'>('all');
  const [s, setS] = useState('');
  const [msg, setMsg] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState(false);
  useEffect(() => { if (chats.data && !sel) setSel(new Set(chats.data.filter((c) => c.watched).map((c) => c.jid))); }, [chats.data, sel]);
  const byName = (n: string) => (q.data ?? []).find((c) => c.name === n);
  const acct = byName('zoho')?.status === 'connected' ? 'zoho' : byName('tally')?.status === 'connected' ? 'tally' : 'zoho';
  const wa = byName('whatsapp');
  const rows = useMemo(() => (chats.data ?? []).filter((c) => (kind === 'all' || (kind === 'group') === c.is_group) && c.name.toLowerCase().includes(s.toLowerCase())), [chats.data, kind, s]);
  const dirty = !!sel && !!chats.data && chats.data.some((c) => c.watched !== sel.has(c.jid));

  async function reconnect(name: string) {
    if (name === 'whatsapp') { setQr(true); return; }
    if (isDemo()) { await api.mockConnect(name); setTimeout(q.reload, 1800); return; }
    if (name === 'google' || name === 'zoho') { window.location.href = api.oauthStartUrl(name); return; }
    window.location.href = '/setup';
  }
  async function save() {
    if (!sel) return;
    setBusy(true); setMsg(null);
    try { await api.setWaChats(Array.from(sel)); setMsg({ tone: 'green', text: `Saved. Watching ${sel.size} chats. Messages from other chats are dropped before they are stored.` }); chats.reload(); }
    catch (e: any) { setMsg({ tone: 'red', text: plainError(e?.message) }); }
    finally { setBusy(false); }
  }
  return (
    <div>
      <PageHead title={t('connections.title')} sub={t('connections.sub')} />
      {q.error && !q.data ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <Skeleton className="h-[130px]" /> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {['google', 'whatsapp', 'sheets', acct].map((n) => <ConnCard key={n} name={n} c={byName(n)} onReconnect={() => reconnect(n)} />)}
        </div>
      )}
      <Card className="mt-3 flex items-start gap-3 px-4 py-3 text-[13.5px] sm:px-5">
        <AlertTriangle size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-amber" />
        <span><b>If WhatsApp logs out</b>, this card turns red and we message you: &quot;Open RevenueGuard and scan the QR again.&quot; Nothing is lost while it&apos;s away. If Zoho is down, cases pause and retry; nothing is billed twice.</span>
      </Card>

      <div className="mt-2 grid gap-x-8 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="min-w-0">
          <div className="sect"><h2>WhatsApp: which chats should we watch?</h2><span>{sel?.size ?? 0} selected</span></div>
          <Card>
            <div className="flex flex-wrap items-center gap-2 border-b border-rule p-3">
              <label className="flex min-w-[200px] flex-1 items-center gap-2 rounded border border-rule-2 bg-card px-3 py-1.5 text-ink-3"><Search size={14} /><input className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink focus:outline-none" placeholder="Search chats" value={s} onChange={(e) => setS(e.target.value)} /></label>
              {(['group', 'person'] as const).map((k) => <button key={k} className={clsx('pill py-1 text-[12.5px]', kind === k && 'pill-on')} onClick={() => setKind(kind === k ? 'all' : k)}>{k === 'group' ? 'Groups' : 'People'}</button>)}
            </div>
            {wa?.status !== 'connected' ? <EmptyState title="WhatsApp is not linked yet." hint="Link it with a QR code. Nothing is read until you tick chats here." action={<button className="btn" onClick={() => setQr(true)}>Link WhatsApp</button>} />
              : !chats.data ? <Skeleton lines={5} className="p-3" />
              : rows.length === 0 ? <EmptyState title="No chats match." />
              : rows.map((c) => {
                const on = sel?.has(c.jid) ?? false;
                return (
                  <label key={c.jid} className="grid cursor-pointer grid-cols-[28px_minmax(0,1fr)] items-center gap-x-3 border-b border-rule px-4 py-3 last:border-0 hover:bg-[#FBF9F3] sm:grid-cols-[28px_minmax(0,1.2fr)_110px_minmax(0,1fr)]">
                    <input type="checkbox" className="h-4 w-4 accent-[#1A1A17]" checked={on} disabled={user?.role !== 'admin'} onChange={() => setSel((p) => { const n = new Set(p ?? []); if (n.has(c.jid)) n.delete(c.jid); else n.add(c.jid); return n; })} />
                    <div className="min-w-0"><div className="truncate font-semibold">{c.name}</div><div className="text-[12.5px] text-ink-3">{c.is_group ? `Group${c.members ? ` · ${c.members} people` : ''}` : 'Person'}</div></div>
                    <div className="col-start-2 text-[12.5px] text-ink-3 sm:col-start-auto sm:text-[13px]">{minsAgo(c.last_message_at)}</div>
                    <div className={clsx('col-start-2 text-[13px] sm:col-start-auto', on ? 'text-ink' : 'text-ink-3')}>{on ? c.note || 'Watched' : 'Not watched · never read or stored'}</div>
                  </label>
                );
              })}
            {wa?.status === 'connected' && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule px-4 py-3">
                <span className={clsx('text-[12.5px]', msg?.tone === 'red' ? 'text-red' : msg ? 'text-green' : 'text-ink-3')}>{msg?.text ?? (user?.role === 'admin' ? 'Changes apply when you save.' : 'Only the owner can change which chats are watched.')}</span>
                <button className="btn" disabled={!dirty || busy || user?.role !== 'admin'} onClick={save}>Save chat list</button>
              </div>
            )}
          </Card>
        </section>
        <aside>
          <div className="sect"><h2>How this works</h2></div>
          <Card className="space-y-3 p-5 text-[13.5px] leading-relaxed">
            <p><b>Ticked chats</b> are read for orders, challans, voice notes and payment replies.</p>
            <p><b>Unticked chats</b> are dropped the moment they arrive. Not saved, not sent to any AI.</p>
            <p><b>New number mentions a PO?</b> We ask you first: &quot;Unknown number sent a challan for PO-201. Watch this chat?&quot;</p>
            <p><b>Your own messages</b> from this number are ignored, so test from another phone.</p>
          </Card>
          {byName('bank') && <Card className="mt-3 flex items-center justify-between p-4 text-[13px]"><span className="flex items-center gap-2"><Landmark size={15} />Bank statement · {byName('bank')?.detail}</span><Link href="/advanced/connectors" className="text-ink-2 underline">Upload</Link></Card>}
        </aside>
      </div>
      {qr && <WaQr onClose={() => setQr(false)} onPaired={() => { setQr(false); q.reload(); chats.reload(); }} />}
    </div>
  );
}
