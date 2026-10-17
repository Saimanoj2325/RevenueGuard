'use client';
import clsx from 'clsx';
import {
  Activity, BarChart3, CalendarDays, ClipboardList, FlaskConical, FolderSearch, Inbox, Link2, LogOut, Menu, MessageCircle,
  ReceiptText, ScrollText, Search, Settings as SettingsIcon, ShieldCheck, Siren, Tags, Users, Wallet, X, Clapperboard, Gauge, Plug,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { setDemo } from '@/lib/config';
import { startFeed } from '@/lib/feed';
import { GUARD_CAPTIONS } from '@/lib/captions';
import { minsAgo } from '@/lib/format';
import { onWs, useAuth, useAuthReady, useDemo, useWs } from '@/lib/store';
import { LANGS, useLang, useT, type TKey } from '@/i18n';
import { ProofDrawer } from './ui';

// ---------------- counts for the sidebar ----------------
interface Counts { bill?: number; collect?: number; customers?: number; approvals?: number; unlinked?: number; conn?: [number, number]; connNames?: string[]; connBad?: string | null; lastSync?: string | null }
function useCounts(enabled: boolean) {
  const [c, setC] = useState<Counts>({});
  const load = useCallback(async () => {
    const safe = <T,>(p: Promise<T>) => p.catch(() => null);
    const [bill, col, cus, apr, unl, con] = await Promise.all([
      safe(api.bill()), safe(api.collect()), safe(api.customers()), safe(api.approvalCards('pending')), safe(api.unlinked()), safe(api.connectorsV2()),
    ]);
    const core = (con ?? []).filter((x) => ['google', 'gmail', 'whatsapp', 'sheets', 'zoho', 'tally'].includes(x.name));
    const accounting = core.filter((x) => x.name === 'zoho' || x.name === 'tally');
    const four = [core.find((x) => x.name === 'google' || x.name === 'gmail'), core.find((x) => x.name === 'whatsapp'), core.find((x) => x.name === 'sheets'), accounting.find((x) => x.status === 'connected') ?? accounting[0]];
    const ok = four.filter((x) => x && x.status === 'connected' && (x.health ?? 'ok') === 'ok').length;
    const bad = four.find((x) => !x || x.status !== 'connected' || (x.health && x.health !== 'ok'));
    const NAMES: Record<string, string> = { google: 'Gmail', gmail: 'Gmail', whatsapp: 'WhatsApp', sheets: 'Sheet', zoho: 'Zoho', tally: 'Tally' };
    const syncs = core.map((x) => x.last_sync).filter(Boolean).sort() as string[];
    setC({
      bill: bill?.items.length, collect: col?.items.length, customers: cus?.length, approvals: apr?.length, unlinked: unl?.items.length,
      conn: con ? [ok, 4] : undefined,
      connNames: ['Gmail', 'WhatsApp', 'Sheet', four[3] ? NAMES[four[3].name] : 'Zoho'],
      connBad: con ? (bad ? `${bad ? NAMES[bad.name] ?? 'Zoho' : 'Zoho'} ${bad?.status === 'connected' ? (bad.health === 'down' ? 'is down' : bad.health === 'relogin' ? 'needs re-login' : 'is slow') : 'not finished'}` : null) : null,
      lastSync: syncs.at(-1) ?? null,
    });
  }, []);
  useEffect(() => {
    if (!enabled) return;
    load();
    let t: any;
    const off = onWs((e) => { if (['case.updated', 'approval.updated', 'connector.updated'].includes(e.type)) { clearTimeout(t); t = setTimeout(load, 700); } });
    const iv = setInterval(load, 60000);
    return () => { off(); clearTimeout(t); clearInterval(iv); };
  }, [enabled, load]);
  return c;
}

// ---------------- nav ----------------
type Item = { href: string; k: TKey; Icon: any; count?: keyof Counts; match?: string[] };
const MAIN: Item[] = [
  { href: '/', k: 'nav.today', Icon: CalendarDays, match: ['/case'] },
  { href: '/bill', k: 'nav.bill', Icon: ReceiptText, count: 'bill' },
  { href: '/collect', k: 'nav.collect', Icon: Wallet, count: 'collect' },
  { href: '/customers', k: 'nav.customers', Icon: Users, count: 'customers' },
  { href: '/approvals', k: 'nav.approvals', Icon: ShieldCheck, count: 'approvals' },
  { href: '/unlinked', k: 'nav.unlinked', Icon: Inbox, count: 'unlinked' },
  { href: '/ask', k: 'nav.ask', Icon: MessageCircle },
];
const BUSINESS: Item[] = [
  { href: '/reports', k: 'nav.reports', Icon: BarChart3 },
];
const SETUP: Item[] = [
  { href: '/setup/connections', k: 'nav.connections', Icon: Link2, count: 'conn', match: ['/setup'] },
  { href: '/settings', k: 'nav.settings', Icon: SettingsIcon },
];
const ADVANCED: (Item & { demoOnly?: boolean })[] = [
  { href: '/advanced/agents', k: 'nav.agents', Icon: Activity },
  { href: '/advanced/audit', k: 'nav.audit', Icon: ScrollText },
  { href: '/advanced/eval', k: 'nav.eval', Icon: FlaskConical },
  { href: '/advanced/cases', k: 'nav.cases', Icon: FolderSearch, match: ['/advanced/case'] },
  { href: '/advanced/triage', k: 'nav.triage', Icon: Tags },
  { href: '/advanced/escalations', k: 'nav.escalations', Icon: Siren },
  { href: '/advanced/metrics', k: 'nav.metrics', Icon: Gauge },
  { href: '/advanced/connectors', k: 'nav.connections', Icon: Plug },
  { href: '/advanced/demo', k: 'nav.demo', Icon: Clapperboard, demoOnly: true },
];

function isActive(path: string, it: Item) {
  const p = path.replace(/\/$/, '') || '/';
  if (it.href === '/') return p === '/' || (it.match ?? []).some((m) => p === m);
  if (p === it.href || p.startsWith(it.href + '/')) return true;
  return (it.match ?? []).some((m) => p === m || (p.startsWith(m + '/') && !p.startsWith('/setup/connections')));
}

export function Brand({ org = true }: { org?: boolean }) {
  return (
    <div>
      <div className="flex items-center gap-2.5 text-[15px] font-bold tracking-[-0.01em]">
        <span className="serif grid h-[26px] w-[26px] place-items-center border-2 border-ink text-[15px] font-bold leading-none">R</span>
        RevenueGuard
      </div>
      {org && <div className="ml-[36px] mt-1 text-[12px] leading-snug text-ink-3">Demo Manufacturing Pvt Ltd</div>}
    </div>
  );
}

function NavList({ counts, onNav, demo }: { counts: Counts; onNav?: () => void; demo: boolean }) {
  const path = usePathname();
  const t = useT();
  const [advOpen, setAdvOpen] = useState(false);
  const row = (it: Item, small = false) => {
    const on = isActive(path, it);
    const c = it.count ? counts[it.count] : undefined;
    const cv = Array.isArray(c) ? `${c[0]}/${c[1]}` : typeof c === 'number' ? String(c) : '';
    return (
      <Link key={it.href} href={it.href} onClick={onNav}
        className={clsx('flex items-center gap-2.5 rounded px-2.5 py-[7px] text-[14px] font-medium transition-colors', on ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-paper-2 hover:text-ink', small && 'py-[6px] text-[13.5px] font-normal')}>
        {!small && <it.Icon size={15} strokeWidth={1.8} className="shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{t(it.k)}</span>
        {cv && <span className={clsx('num text-[12px]', on ? 'text-[#BDB8AA]' : 'text-ink-3')}>{cv}</span>}
      </Link>
    );
  };
  const advItems = ADVANCED.filter((a) => !a.demoOnly || demo);
  const advShown = advOpen ? advItems : advItems.slice(0, 3);
  return (
    <nav className="flex flex-col gap-0.5" aria-label="Primary">
      {MAIN.map((i) => row(i))}
      <div className="mx-2.5 mb-1 mt-4 text-[11px] uppercase tracking-[0.12em] text-ink-3">{t('nav.business')}</div>
      {BUSINESS.map((i) => row(i))}
      {SETUP.map((i) => row(i))}
      <div className="mx-2.5 mb-1 mt-4 text-[11px] uppercase tracking-[0.12em] text-ink-3">{t('nav.advanced')}</div>
      {advShown.map((i) => row(i, true))}
      {advItems.length > 3 && (
        <button className="mx-2.5 mt-0.5 text-left text-[12px] text-ink-3 hover:text-ink" onClick={() => setAdvOpen((v) => !v)}>
          {advOpen ? 'Show less' : `Old screens: cases, triage, escalations…`}
        </button>
      )}
    </nav>
  );
}

function HealthFoot({ counts }: { counts: Counts }) {
  const status = useWs((s) => s.status);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(i); }, []);
  const bad = counts.connBad;
  return (
    <div className="mt-auto px-2.5 pt-6 text-[12px] leading-[1.7] text-ink-3">
      <div>{(counts.connNames ?? ['Gmail', 'WhatsApp', 'Sheet', 'Zoho']).join(', ')}</div>
      {counts.conn ? (
        bad ? <div className="flex items-center gap-1.5 text-amber"><span className="h-2 w-2 rounded-full bg-amber" />{bad}</div>
          : <div><span className="inline-flex items-center gap-1.5 text-green"><span className="h-2 w-2 rounded-full bg-green" />All connected</span> · synced {minsAgo(counts.lastSync, now)}</div>
      ) : <div>Checking connections…</div>}
      {status !== 'open' && <div className="text-amber">Live updates {status === 'reconnecting' ? 'reconnecting…' : 'connecting…'}</div>}
    </div>
  );
}

// ---------------- top bar ----------------
interface Hit { label: string; sub: string; href: string }
function SearchBox() {
  const t = useT();
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === '/' && !/input|textarea|select/i.test((e.target as HTMLElement)?.tagName)) { e.preventDefault(); ref.current?.focus(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const loadIdx = async () => {
    if (idx.length) return;
    const safe = <T,>(p: Promise<T>) => p.catch(() => null);
    const [cus, bill, col, cases] = await Promise.all([safe(api.customers()), safe(api.bill()), safe(api.collect()), safe(api.cases())]);
    const hits: Hit[] = [];
    (cus ?? []).forEach((c) => hits.push({ label: c.name, sub: `Customer · ${c.city}`, href: `/customers?id=${encodeURIComponent(c.id)}` }));
    (bill?.items ?? []).forEach((b) => hits.push({ label: b.po_ref, sub: `${b.customer} · ${b.case_ref}`, href: `/case?id=${encodeURIComponent(b.case_ref)}` }));
    (col?.items ?? []).forEach((c) => hits.push({ label: c.invoice_number, sub: `Invoice · ${c.customer}`, href: `/customers?id=${encodeURIComponent(c.customer_id)}` }));
    (cases ?? []).forEach((c) => hits.push({ label: c.id, sub: `Case · ${c.reference ?? ''} ${c.customer ?? ''}`, href: `/case?id=${encodeURIComponent(c.id)}` }));
    setIdx(hits);
  };
  const ql = q.trim().toLowerCase();
  const hits = ql ? idx.filter((h) => (h.label + ' ' + h.sub).toLowerCase().includes(ql)).slice(0, 6) : [];
  const options: Hit[] = ql ? [...hits, { label: `Ask: “${q.trim()}”`, sub: 'Answer with proof', href: `/ask?q=${encodeURIComponent(q.trim())}` }] : [];
  const go = (h: Hit) => { setOpen(false); setQ(''); ref.current?.blur(); router.push(h.href); };
  return (
    <div className="relative w-full max-w-[420px]">
      <label className="flex items-center gap-2.5 rounded border border-rule-2 bg-card px-3 py-[8px] text-ink-3 focus-within:border-ink">
        <Search size={15} strokeWidth={1.8} className="shrink-0" />
        <input ref={ref} value={q} placeholder={t('top.search')} aria-label={t('top.search')}
          className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-3 focus:outline-none"
          onFocus={() => { setOpen(true); loadIdx(); }} onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setQ(e.target.value); setSel(0); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(options.length - 1, s + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            if (e.key === 'Enter' && options.length) { e.preventDefault(); go(options[Math.min(sel, options.length - 1)]); }
            if (e.key === 'Escape') { setQ(''); ref.current?.blur(); }
          }} />
        <kbd className="hidden rounded border border-rule-2 px-1.5 text-[11px] text-ink-3 sm:inline">/</kbd>
      </label>
      {open && options.length > 0 && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 overflow-hidden rounded border border-rule-2 bg-card">
          {options.map((h, i) => (
            <button key={h.href + i} onMouseDown={(e) => { e.preventDefault(); go(h); }} className={clsx('flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-[13.5px]', i === sel ? 'bg-paper-2' : 'hover:bg-paper')}>
              <span className="truncate font-medium">{h.label}</span><span className="truncate text-[12px] text-ink-3">{h.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LangSwitch({ compact }: { compact?: boolean }) {
  const { lang, setLang } = useLang();
  return (
    <div className="flex items-center gap-2.5 text-[12.5px]" role="group" aria-label="Language">
      {LANGS.map((l) => (
        <button key={l.id} onClick={() => setLang(l.id)} aria-pressed={lang === l.id}
          className={clsx(lang === l.id ? 'font-semibold text-ink' : 'text-ink-3 hover:text-ink')}>{compact ? (l.id === 'en' ? 'EN' : l.id === 'hi' ? 'हि' : 'తె') : l.short}</button>
      ))}
    </div>
  );
}

export function DemoSwitch({ className }: { className?: string }) {
  const demo = useDemo();
  const t = useT();
  return (
    <button role="switch" aria-checked={demo} onClick={() => { if (confirm(demo ? 'Turn off demo mode? You will be signed out and the app will use your real data.' : 'Turn on demo mode? You will be signed out and see sample data (no server needed).')) setDemo(!demo); }}
      className={clsx('inline-flex items-center gap-2 text-[12.5px] font-medium text-ink-2', className)} title="Demo mode: sample data in the browser">
      <span className="toggle" aria-checked={demo}><span /></span>{t('top.demo')}
    </button>
  );
}

function Avatar() {
  const { user, logout } = useAuth();
  const disconnect = useWs((s) => s.disconnect);
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const name = user?.name ?? user?.email ?? '?';
  const ini = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('');
  const ROLE: Record<string, string> = { admin: 'Owner', operator: 'Accounts', finance_approver: 'Finance approver', viewer: 'Viewer' };
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="grid h-8 w-8 place-items-center rounded-full bg-ink text-[12px] font-semibold text-paper" aria-label="Account" aria-expanded={open}>{ini}</button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-10 z-50 w-[230px] rounded border border-rule-2 bg-card p-3 text-[13px]">
            <div className="font-semibold">{name}</div>
            <div className="text-ink-3">{user?.email}</div>
            <div className="mt-1 tag t-grey">{ROLE[user?.role ?? ''] ?? user?.role}</div>
            <button className="btn-ghost btn-sm mt-3 w-full" onClick={() => { disconnect(); logout(); router.replace('/login'); }}><LogOut size={13} />{t('top.signout')}</button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------- guardrail toasts (plain words) ----------------
function Toasts() {
  const toasts = useWs((s) => s.toasts);
  const dismiss = useWs((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-20 right-3 z-50 flex w-[min(360px,calc(100vw-24px))] flex-col gap-2 sm:bottom-4" aria-live="polite">
      {toasts.map((x) => {
        const g = GUARD_CAPTIONS[x.kind];
        const tone = g?.[1] ?? 'ink';
        return (
          <div key={x.id} className={clsx('pointer-events-auto flex animate-slidein items-start gap-2 rounded border bg-card px-3 py-2.5 text-[13px]', tone === 'red' ? 'border-red/40' : tone === 'amber' ? 'border-amber/40' : tone === 'green' ? 'border-green/40' : 'border-rule-2')}>
            <ShieldCheck size={15} strokeWidth={1.8} className={clsx('mt-0.5 shrink-0', tone === 'red' ? 'text-red' : tone === 'amber' ? 'text-amber' : tone === 'green' ? 'text-green' : 'text-ink-2')} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{g?.[0] ?? 'Safety check'}</div>
              {x.case_id && <Link href={`/case?id=${x.case_id}`} className="text-[12px] text-ink-3 hover:text-ink">Case {x.case_id}</Link>}
            </div>
            <button onClick={() => dismiss(x.id)} aria-label="Dismiss" className="text-ink-3 hover:text-ink"><X size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------- shortcuts ----------------
const SHORTCUTS: [string, string][] = [['/', 'Search or ask'], ['g t', 'Today'], ['g b', 'To bill'], ['g c', 'To collect'], ['g a', 'Approvals'], ['?', 'This help']];
function useShortcuts(onHelp: () => void) {
  const router = useRouter();
  useEffect(() => {
    let g = 0;
    const k = (e: KeyboardEvent) => {
      if (/input|textarea|select/i.test((e.target as HTMLElement)?.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '?') { onHelp(); return; }
      if (e.key === 'g') { g = Date.now(); return; }
      if (Date.now() - g < 1200) {
        const to = ({ t: '/', b: '/bill', c: '/collect', a: '/approvals' } as Record<string, string>)[e.key];
        if (to) { router.push(to); g = 0; }
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [router, onHelp]);
}

// ---------------- mobile bottom nav ----------------
const BOTTOM: { href: string; k: TKey; Icon: any }[] = [
  { href: '/', k: 'nav.today', Icon: CalendarDays },
  { href: '/approvals', k: 'nav.approve', Icon: ShieldCheck },
  { href: '/collect', k: 'nav.collect', Icon: Wallet },
  { href: '/ask', k: 'nav.ask', Icon: MessageCircle },
];
function BottomNav({ counts }: { counts: Counts }) {
  const path = usePathname();
  const t = useT();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-rule-2 bg-card pb-[env(safe-area-inset-bottom)] sm:hidden" aria-label="Phone">
      {BOTTOM.map((b) => {
        const on = isActive(path, { ...b, match: b.href === '/' ? ['/case'] : [] });
        const n = b.href === '/approvals' ? counts.approvals : undefined;
        return (
          <Link key={b.href} href={b.href} className={clsx('relative flex flex-col items-center gap-0.5 py-2 text-[11.5px]', on ? 'font-semibold text-ink' : 'text-ink-3')}>
            <b.Icon size={18} strokeWidth={1.8} />
            {t(b.k)}
            {!!n && <span className="num absolute right-[calc(50%-20px)] top-1 rounded-full bg-amber px-1 text-[10px] font-semibold text-white">{n}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

// ---------------- shell ----------------
export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const ready = useAuthReady();
  const token = useAuth((s) => s.token);
  const connect = useWs((s) => s.connect);
  const demo = useDemo();
  const t = useT();
  const [navOpen, setNavOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const counts = useCounts(!!token && ready);
  const onHelp = useMemo(() => () => setHelp((v) => !v), []);
  useShortcuts(onHelp);

  useEffect(() => { if (ready && !token) router.replace('/login'); }, [ready, token, router]);
  useEffect(() => { if (token) { startFeed(); connect(token); } }, [token, connect]);
  useEffect(() => { setNavOpen(false); }, [path]);

  if (!ready || !token) return <div className="grid min-h-screen place-items-center"><span className="text-[13px] text-ink-3">Opening RevenueGuard…</span></div>;

  const bare = path.replace(/\/$/, '') === '/setup/first-day';
  if (bare) return <>{children}<ProofDrawer /><Toasts /></>;

  return (
    <div className="min-h-screen lg:pl-[220px]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[220px] flex-col overflow-y-auto border-r border-rule-2 bg-paper px-4 py-5 lg:flex">
        <div className="mb-5 px-1"><Brand /></div>
        <NavList counts={counts} demo={demo} />
        <HealthFoot counts={counts} />
      </aside>

      {navOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-ink/30 lg:hidden" onClick={() => setNavOpen(false)} />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-[260px] flex-col overflow-y-auto border-r border-rule-2 bg-paper px-4 py-5 lg:hidden">
            <div className="mb-5 flex items-start justify-between px-1"><Brand /><button onClick={() => setNavOpen(false)} aria-label="Close menu" className="text-ink-3"><X size={18} /></button></div>
            <NavList counts={counts} demo={demo} onNav={() => setNavOpen(false)} />
            <div className="mt-4 flex flex-col gap-3 px-2.5"><LangSwitch /><DemoSwitch /></div>
            <HealthFoot counts={counts} />
          </aside>
        </>
      )}

      <header className="sticky top-0 z-20 border-b border-rule bg-paper/95 lg:border-b-0 lg:bg-paper">
        <div className="mx-auto flex max-w-[1480px] items-center gap-3 px-4 py-3 sm:px-6 lg:px-9 lg:pt-5">
          <button className="text-ink-2 lg:hidden" onClick={() => setNavOpen(true)} aria-label="Open menu"><Menu size={20} /></button>
          <div className="lg:hidden"><Brand org={false} /></div>
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-4">
            <div className="hidden min-w-0 flex-1 justify-end md:flex"><SearchBox /></div>
            <div className="hidden lg:block"><LangSwitch /></div>
            <div className="hidden sm:block"><DemoSwitch /></div>
            {demo && <span className="tag t-amber">{t('top.demoData')}</span>}
            <Avatar />
          </div>
        </div>
        <div className="px-4 pb-3 md:hidden"><SearchBox /></div>
      </header>

      <main className="mx-auto w-full max-w-[1480px] px-4 pb-24 pt-3 sm:px-6 sm:pb-12 lg:px-9">{children}</main>
      <BottomNav counts={counts} />
      <Toasts />
      <ProofDrawer />
      {help && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-ink/30" onClick={() => setHelp(false)}>
          <div className="w-[320px] rounded border border-rule-2 bg-card p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between font-semibold">Keyboard shortcuts <button onClick={() => setHelp(false)} aria-label="Close"><X size={15} /></button></div>
            {SHORTCUTS.map(([k, v]) => <div key={k} className="flex justify-between border-b border-rule py-1.5 text-[13px] last:border-0"><kbd className="mono rounded border border-rule-2 px-1.5 text-[12px]">{k}</kbd><span className="text-ink-2">{v}</span></div>)}
          </div>
        </div>
      )}
    </div>
  );
}
