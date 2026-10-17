'use client';
import clsx from 'clsx';
import {
  AlertTriangle, Ban, Check, Copy, CopyX, FileSpreadsheet, FileText, Image as ImageIcon, Landmark, Mail,
  MessageCircle, Mic, PauseCircle, Power, RotateCcw, ShieldAlert, ShieldX, Siren, TimerOff, Zap, BookOpen, Search,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { argmax, human, stateTone } from '@/lib/format';
import type { CaseState, Provider, Severity, Source } from '@/lib/types';

export const SEV_COLOR: Record<string, string> = { low: '#1E5A3C', medium: '#9A6A12', high: '#B23A26', critical: '#B23A26' };

const TONES = {
  ink: 'border-rule text-ink-2 bg-card',
  amber: 'border-[#9A6A12]/50 text-[#9A6A12] bg-[#9A6A12]/10',
  red: 'border-red/60 text-[#B23A26] bg-red/10',
  green: 'border-green/50 text-[#1E5A3C] bg-green/10',
  blue: 'border-ink-2/50 text-[#55534C] bg-ink-2/10',
};

export function StateChip({ state, pulse }: { state: CaseState; pulse?: boolean }) {
  const tone = stateTone(state);
  return (
    <span className={clsx('chip', TONES[tone])}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', pulse && 'animate-pulse', {
        'bg-ink-3': tone === 'ink', 'bg-[#9A6A12]': tone === 'amber', 'bg-red': tone === 'red', 'bg-green': tone === 'green', 'bg-ink-2': tone === 'blue',
      })} />
      {human(state)}
    </span>
  );
}

/** Calibrated probability bar: Laya's distribution low→critical as proportional segments + argmax marker. */
export function SeverityBar({ probs, severity, compact, onPaper }: { probs?: Record<string, number> | null; severity?: Severity | null; compact?: boolean; onPaper?: boolean }) {
  const order: Severity[] = ['low', 'medium', 'high', 'critical'];
  const p = probs ?? (severity ? { [severity]: 1 } : null);
  const top = argmax(p);
  if (!p) return <span className="num text-xs text-ink-3">—</span>;
  const total = order.reduce((s, k) => s + (p[k] ?? 0), 0) || 1;
  let acc = 0;
  const label = top ? `${top[0]} p=${top[1].toFixed(2)}` : '';
  return (
    <div className={clsx('flex items-center gap-2', compact ? 'min-w-[120px]' : 'min-w-[180px]')} title={order.map((k) => `${k}: ${(p[k] ?? 0).toFixed(2)}`).join('  ')}>
      <div className={clsx('relative h-2 flex-1 overflow-hidden rounded-[2px]', onPaper ? 'bg-rule' : 'bg-paper-2')} role="img" aria-label={`Severity distribution, most likely ${label}`}>
        {order.map((k) => {
          const w = ((p[k] ?? 0) / total) * 100;
          const left = acc;
          acc += w;
          return <span key={k} className="absolute inset-y-0" style={{ left: `${left}%`, width: `${w}%`, background: SEV_COLOR[k], opacity: top?.[0] === k ? 1 : 0.38 }} />;
        })}
        {/* expected-severity tick */}
        <span className="absolute inset-y-[-2px] w-[2px] bg-white mix-blend-difference" style={{ left: `${(order.reduce((s, k, i) => s + (p[k] ?? 0) * i, 0) / total / 3) * 100}%` }} />
      </div>
      <span className={clsx('num shrink-0 text-[11px]', onPaper ? 'text-ink' : 'text-ink-2')} style={{ color: top ? SEV_COLOR[top[0]] : undefined }}>
        {compact ? top?.[0]?.slice(0, 4).toUpperCase() : label}
      </span>
    </div>
  );
}

/** Generic Laya answer distribution (choice / score / noul). */
export function ProbList({ probs, onPaper }: { probs?: Record<string, number>; onPaper?: boolean }) {
  if (!probs) return null;
  const rows = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-1">
      {rows.map(([k, v], i) => (
        <div key={k} className="flex items-center gap-2 text-[11px]">
          <span className={clsx('num w-[118px] shrink-0 truncate', onPaper ? 'text-ink' : 'text-ink-2')}>{human(k)}</span>
          <div className={clsx('h-1.5 flex-1 rounded-sm', onPaper ? 'bg-rule' : 'bg-paper-2')}>
            <div className="h-full rounded-sm" style={{ width: `${v * 100}%`, background: SEV_COLOR[k] ?? (i === 0 ? '#B23A26' : onPaper ? '#55534C' : '#55534C') }} />
          </div>
          <span className={clsx('num w-9 text-right', onPaper ? 'text-ink-3' : 'text-ink-3')}>{v.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

export const SOURCE_META: Record<string, { label: string; color: string; Icon: any }> = {
  gmail: { label: 'Gmail', color: '#E06A5B', Icon: Mail },
  whatsapp: { label: 'WhatsApp', color: '#4FBF7F', Icon: MessageCircle },
  sheets: { label: 'Sheets', color: '#1E5A3C', Icon: FileSpreadsheet },
  drive: { label: 'Drive', color: '#9A6A12', Icon: FileText },
  zoho: { label: 'Zoho Books', color: '#6E9BD1', Icon: BookOpen },
  bank: { label: 'Bank', color: '#B48CD6', Icon: Landmark },
  media: { label: 'Media', color: '#B23A26', Icon: ImageIcon },
};
export function SourceIcon({ source, kind, size = 14 }: { source: Source | string; kind?: string; size?: number }) {
  const m = SOURCE_META[source] ?? { color: '#55534C', Icon: FileText };
  const Icon = kind === 'voice_note' ? Mic : kind === 'search' ? Search : m.Icon;
  return <Icon size={size} style={{ color: m.color }} aria-hidden />;
}

export function Stamp({ children, color = '#B7281F', className }: { children: ReactNode; color?: string; className?: string }) {
  return <span className={clsx('stamp', className)} style={{ color, borderColor: color }}>{children}</span>;
}

export const PROVIDER_META: Record<Provider, { label: string; cls: string }> = {
  nim: { label: 'NIM', cls: 'border-[#1E5A3C]/60 text-[#1E5A3C] bg-[#1E5A3C]/10' },
  groq: { label: 'Groq', cls: 'border-[#B23A26]/60 text-[#B23A26] bg-[#B23A26]/10' },
  ollama: { label: 'Ollama', cls: 'border-ink-3 text-ink-2 bg-card' },
};
const PROVIDER_PAPER: Record<Provider, string> = {
  nim: 'border-[#1E5A3C]/60 text-[#1E5A3C] bg-[#1E5A3C]/10',
  groq: 'border-[#B23A26]/60 text-[#B23A26] bg-[#B23A26]/10',
  ollama: 'border-ink-3 text-ink bg-paper-2',
};
export function ProviderBadge({ provider, model, onPaper }: { provider?: Provider | string; model?: string; onPaper?: boolean }) {
  const known = (provider as Provider) in PROVIDER_META;
  const key = (known ? provider : 'ollama') as Provider;
  const m = PROVIDER_META[key];
  // unknown providers (e.g. the harness MOCK_LLM "mock" provider) keep their own name instead of borrowing a label
  return <span className={clsx('chip', onPaper ? PROVIDER_PAPER[key] : m.cls)} title={model}>{known ? m.label : String(provider ?? '?').toUpperCase()}{model ? <span className="normal-case tracking-normal opacity-70">{model.split('/').pop()}</span> : null}</span>;
}

export const GUARD_META: Record<string, { label: string; Icon: any; color: string }> = {
  injection: { label: 'Injection quarantined', Icon: ShieldX, color: '#B23A26' },
  role_block: { label: 'Role block', Icon: Ban, color: '#B23A26' },
  duplicate_block: { label: 'Duplicate blocked', Icon: CopyX, color: '#B23A26' },
  approval_expired: { label: 'Approval expired', Icon: TimerOff, color: '#9A6A12' },
  paused: { label: 'Paused', Icon: PauseCircle, color: '#9A6A12' },
  resumed: { label: 'Resumed', Icon: RotateCcw, color: '#1E5A3C' },
  fallback: { label: 'Provider fallback', Icon: Zap, color: '#55534C' },
  escalated: { label: 'Escalated', Icon: Siren, color: '#B23A26' },
  kill_switch: { label: 'Kill switch', Icon: Power, color: '#B23A26' },
  validator_block: { label: 'Validator block', Icon: ShieldAlert, color: '#B23A26' },
};
export const guardMeta = (k: string) => GUARD_META[k] ?? { label: human(k), Icon: AlertTriangle, color: '#9A6A12' };

export function CopyText({ text, display, className }: { text: string; display?: string; className?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className={clsx('num group inline-flex max-w-full items-center gap-1.5 truncate text-left', className)}
      onClick={() => { navigator.clipboard?.writeText(text).catch(() => {}); setOk(true); setTimeout(() => setOk(false), 1200); }}
      title={`Copy ${text}`}
    >
      <span className="truncate">{display ?? text}</span>
      {ok ? <Check size={12} className="shrink-0 text-green" /> : <Copy size={12} className="shrink-0 opacity-40 group-hover:opacity-90" />}
    </button>
  );
}

export function Empty({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-rule px-6 py-12 text-center">
      {icon}
      <div className="serif text-lg text-[#1A1A17]">{title}</div>
      {hint && <div className="max-w-md text-sm text-ink-3">{hint}</div>}
    </div>
  );
}

export function PageHead({ kicker, title, children }: { kicker: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="eyebrow mb-1">{kicker}</div>
        <h1 className="serif text-[28px] font-medium leading-none tracking-tight text-[#1A1A17] sm:text-[34px]">{title}</h1>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded-md border border-red/50 bg-red/10 px-3 py-2 text-sm text-[#B23A26]">{error}</div>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-md bg-card', className)} />;
}
