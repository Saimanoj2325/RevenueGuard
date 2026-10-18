'use client';
import clsx from 'clsx';
import { AlertTriangle, FileSpreadsheet, Landmark, Mail, Megaphone, MessageCircle, Network, Radio, ReceiptText, RefreshCw, Search, User, Users } from 'lucide-react';
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
import type { ConnectorV2, WaChat, WaChatKind } from '@/lib/v2types';
import { FILTERS, chatKind, chatSubtitle, chatTitle, inFilter, isFaceless, matchesSearch, sortChats, type ChatFilter } from '@/lib/waChats';

const META: Record<string, { label: string; Icon: any; todo: string }> = {
  google: { label: 'Gmail', Icon: Mail, todo: 'Sign in with Google to read order and payment emails.' },
  whatsapp: { label: 'WhatsApp', Icon: MessageCircle, todo: 'Scan a QR code with WhatsApp on your phone.' },
  sheets: { label: 'Delivery sheet', Icon: FileSpreadsheet, todo: 'Pick the Google Sheet where deliveries are logged.' },
  zoho: { label: 'Zoho Books', Icon: ReceiptText, todo: 'Sign in to Zoho Books to raise invoices.' },
  tally: { label: 'Tally', Icon: ReceiptText, todo: 'Connect Tally to raise invoices.' },
  bank: { label: 'Bank statement', Icon: Landmark, todo: 'Upload a bank statement CSV.' },
};
/** Card name -> connector row name in the API ("google" is the Gmail connector). */
const ROW_NAME: Record<string, string> = { google: 'gmail' };
const KIND_ICON: Record<WaChatKind, any> = { person: User, group: Users, community: Network, announcement: Megaphone, channel: Radio, broadcast: Radio };
const KIND_TONE: Record<WaChatKind, string> = {
  person: 'bg-[#EEF3EC] text-[#2F5D3A]', group: 'bg-[#EAF0F7] text-[#2C4F7C]', community: 'bg-[#F3ECF7] text-[#5E3A7C]',
  announcement: 'bg-[#F3ECF7] text-[#5E3A7C]', channel: 'bg-[#FBF1E4] text-[#8A5A1C]', broadcast: 'bg-[#FBF1E4] text-[#8A5A1C]',
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
  const notLinked = !c || c.status === 'disconnected';
  return (
    <Card className="flex flex-col p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2.5 font-semibold"><m.Icon size={17} strokeWidth={1.8} />{m.label}</span>
        <span className={clsx('inline-flex items-center gap-1.5 text-[13px]', h.tone === 'green' ? 'text-green' : h.tone === 'red' ? 'text-red' : 'text-amber')}><span className={clsx('h-2 w-2 rounded-full', h.tone === 'green' ? 'bg-green' : h.tone === 'red' ? 'bg-red' : 'bg-amber')} />{h.word}</span>
      </div>
      {notLinked ? (
        <div className="mt-2 text-[13.5px] text-ink-3">{m.todo}</div>
      ) : (
        <>
          {(c?.account || c?.detail) && <div className="mt-2 text-[13px] text-ink-3">{[c?.account, c?.detail].filter(Boolean).join(' · ')}</div>}
          <div className="mt-1 text-[13.5px]">{c?.error_plain && h.tone !== 'green' ? <span className={h.tone === 'red' ? 'text-red' : 'text-amber'}>{c.error_plain}</span> : c?.last_sync ? `Synced ${minsAgo(c.last_sync)}` : 'Waiting for first sync'}</div>
        </>
      )}
      {h.tone !== 'green' && <button className="btn-ghost btn-sm mt-3 self-start" onClick={onReconnect}><RefreshCw size={13} />{notLinked ? 'Connect' : 'Reconnect'}</button>}
    </Card>
  );
}

export default function ConnectionsPage() {
  const t = useT();
  const user = useAuth((s) => s.user);
  const q = useLive(() => api.connectorsV2(), [], (e) => e.type === 'connector.updated', 200);
  const chats = useLive(() => api.waChats().catch(() => [] as WaChat[]), []);
  const [sel, setSel] = useState<Set<string> | null>(null);
  const [kind, setKind] = useState<ChatFilter>('all');
  // chats that sort to the top: the selection as it stood when the list loaded, the filter/search changed, or it was saved.
  // Not re-sorted on every tick, so a row never jumps away from under the cursor.
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [s, setS] = useState('');
  const [msg, setMsg] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState(false);
  useEffect(() => {
    if (chats.data && !sel) { const w = new Set(chats.data.filter((c) => c.watched).map((c) => c.jid)); setSel(w); setPinned(w); }
  }, [chats.data, sel]);
  // re-pin the current selection whenever the filter or search changes
  useEffect(() => { if (sel) setPinned(new Set(sel)); }, [kind, s]); // eslint-disable-line react-hooks/exhaustive-deps
  const byName = (n: string) => (q.data ?? []).find((c) => c.name === (ROW_NAME[n] ?? n));
  const acct = byName('zoho')?.status === 'connected' ? 'zoho' : byName('tally')?.status === 'connected' ? 'tally' : 'zoho';
  const wa = byName('whatsapp');
  const waOn = wa?.status === 'connected';
  useEffect(() => { if (waOn) chats.reload(); }, [waOn]); // eslint-disable-line react-hooks/exhaustive-deps
  // chats left in the bridge from an earlier pairing are not shown (or counted) until WhatsApp is linked again
  const [showHidden, setShowHidden] = useState(false);
  const linked = useMemo(() => (waOn ? (chats.data ?? []) : []).filter((c) => chatKind(c) !== 'broadcast' || c.watched), [chats.data, waOn]);
  // 1:1 chats WhatsApp gave no number or name for (privacy IDs it hasn't mapped yet) stay out of the list unless asked for, or already ticked
  const hiddenCount = useMemo(() => linked.filter((c) => isFaceless(c) && !sel?.has(c.jid)).length, [linked, sel]);
  const all = useMemo(() => linked.filter((c) => showHidden || !isFaceless(c) || sel?.has(c.jid)), [linked, showHidden, sel]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, all.filter((c) => inFilter(c, f.key, sel ?? new Set())).length])) as Record<ChatFilter, number>, [all, sel]);
  const rows = useMemo(() => sortChats(all.filter((c) => inFilter(c, kind, pinned) && matchesSearch(c, s)), pinned), [all, kind, s, pinned]);
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
    try { await api.setWaChats(Array.from(sel)); setPinned(new Set(sel)); setMsg({ tone: 'green', text: `Saved. Watching ${sel.size} chats. Messages from other chats are dropped before they are stored.` }); chats.reload(); }
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
              <div className="flex flex-wrap gap-1.5">
                {waOn && FILTERS.filter((f) => f.key === 'all' || counts[f.key] > 0 || kind === f.key).map((f) => (
                  <button key={f.key} className={clsx('pill py-1 text-[12.5px]', kind === f.key && 'pill-on')} onClick={() => setKind(kind === f.key && f.key !== 'all' ? 'all' : f.key)}>
                    {f.label}<span className="ml-1 tabular-nums opacity-60">{counts[f.key]}</span>
                  </button>
                ))}
              </div>
            </div>
            {wa?.status !== 'connected' ? <EmptyState title="WhatsApp is not linked yet." hint="Link it with a QR code. Nothing is read until you tick chats here." action={<button className="btn" onClick={() => setQr(true)}>Link WhatsApp</button>} />
              : !chats.data ? <Skeleton lines={5} className="p-3" />
              : rows.length === 0 ? <EmptyState title={kind === 'selected' ? 'No chats selected yet.' : 'No chats match.'} />
              : rows.map((c, i) => {
                const on = sel?.has(c.jid) ?? false;
                const k = chatKind(c);
                const KIcon = KIND_ICON[k];
                const firstUnpinned = i > 0 && pinned.has(rows[i - 1]!.jid) && !pinned.has(c.jid);
                return (
                  <label key={c.jid} className={clsx(firstUnpinned && 'border-t-2 border-t-rule-2', 'grid cursor-pointer grid-cols-[28px_minmax(0,1fr)] items-center gap-x-3 border-b border-rule px-4 py-3 last:border-0 hover:bg-[#FBF9F3] sm:grid-cols-[28px_minmax(0,1.2fr)_110px_minmax(0,1fr)]')}>
                    <input type="checkbox" className="h-4 w-4 accent-[#1A1A17]" checked={on} disabled={user?.role !== 'admin'} onChange={() => setSel((p) => { const n = new Set(p ?? []); if (n.has(c.jid)) n.delete(c.jid); else n.add(c.jid); return n; })} />
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className={clsx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', KIND_TONE[k])} title={k}><KIcon size={15} strokeWidth={1.8} /></span>
                      <div className="min-w-0"><div className="truncate font-semibold">{chatTitle(c)}</div><div className="truncate text-[12.5px] text-ink-3">{chatSubtitle(c)}</div></div>
                    </div>
                    <div className="col-start-2 text-[12.5px] text-ink-3 sm:col-start-auto sm:text-[13px]">{minsAgo(c.last_message_at)}</div>
                    <div className={clsx('col-start-2 text-[13px] sm:col-start-auto', on ? 'text-ink' : 'text-ink-3')}>{on ? c.note || 'Watched' : 'Not watched · never read or stored'}</div>
                  </label>
                );
              })}
            {waOn && hiddenCount > 0 && (
              <button className="w-full border-t border-rule px-4 py-2.5 text-left text-[12.5px] text-ink-3 hover:bg-[#FBF9F3]" onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? 'Hide' : 'Show'} {hiddenCount} {hiddenCount === 1 ? 'chat' : 'chats'} where WhatsApp has not shared the number yet. They fill in as those people message you.
              </button>
            )}
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
          {byName('bank') && <Card className="mt-3 flex items-center justify-between p-4 text-[13px]"><span className="flex items-center gap-2"><Landmark size={15} />{byName('bank')?.detail ? `Bank statement · ${byName('bank')?.detail}` : 'Bank statement: none uploaded yet'}</span><Link href="/advanced/connectors" className="text-ink-2 underline">Upload</Link></Card>}
        </aside>
      </div>
      {qr && <WaQr onClose={() => setQr(false)} onPaired={() => { setQr(false); q.reload(); chats.reload(); }} />}
    </div>
  );
}
