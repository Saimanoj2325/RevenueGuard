// Plain-words helpers for the CONTRACT_V3 "What happened" timeline, agent decision and chat memory.
// Everything here is defensive: older API builds send none of these fields, newer ones may send partial shapes.
import type { ChatMemory, ChatMemoryCase, GstPreview, TimelineDecisionSummary, TimelineEvent } from './v2types';

export type BadgeTone = 'red' | 'amber' | 'green' | 'grey';
export interface Badge { key: 'edited' | 'deleted' | 'duplicate' | 'superseded' | 'read_by'; label: string; tone: BadgeTone; note?: string }

const LANG: Record<string, string> = {
  hi: 'Hindi', 'hi-in': 'Hindi', te: 'Telugu', 'te-in': 'Telugu', ta: 'Tamil', 'ta-in': 'Tamil', kn: 'Kannada', 'kn-in': 'Kannada',
  ml: 'Malayalam', 'ml-in': 'Malayalam', mr: 'Marathi', 'mr-in': 'Marathi', bn: 'Bengali', 'bn-in': 'Bengali', gu: 'Gujarati', 'gu-in': 'Gujarati',
  pa: 'Punjabi', 'pa-in': 'Punjabi', od: 'Odia', 'od-in': 'Odia', ur: 'Urdu', en: 'English', 'en-in': 'English',
};
const READER: Record<string, string> = { sarvam: 'Sarvam', nim: 'NVIDIA', 'nim-omni': 'NVIDIA', groq: 'Groq Whisper', whisper: 'Whisper', mock: 'Demo reader', vision: 'Photo reader', ocr: 'Photo reader' };

export function languageName(code?: string | null): string | null {
  if (!code) return null;
  const k = code.trim().toLowerCase();
  if (!k || k === 'unknown') return null;
  return LANG[k] ?? (k.length > 3 ? code : code.toUpperCase());
}

/** "Sarvam · Hindi" from read_by + language (either may be missing). */
export function readByLabel(e: Pick<TimelineEvent, 'read_by' | 'language'>): string | null {
  const who = e.read_by ? READER[e.read_by.toLowerCase()] ?? e.read_by.charAt(0).toUpperCase() + e.read_by.slice(1) : null;
  const lang = languageName(e.language);
  if (!who && !lang) return null;
  return [who, lang].filter(Boolean).join(' · ');
}

export function statusOf(e: TimelineEvent): string {
  return (e.status ?? 'active').toLowerCase();
}

/** Is this event part of the delivered total? Deleted / duplicate never count. */
export function counts(e: TimelineEvent): boolean {
  const s = statusOf(e);
  if (s === 'deleted' || s === 'duplicate') return false;
  return (e.role ?? '').toLowerCase() === 'counts';
}

export function badgesFor(e: TimelineEvent): Badge[] {
  const b: Badge[] = [];
  const s = statusOf(e);
  if (s === 'edited' || (e.versions?.length ?? 0) > 0) b.push({ key: 'edited', label: 'Edited', tone: 'amber', note: e.versions?.length ? `${e.versions.length} old version${e.versions.length > 1 ? 's' : ''}` : undefined });
  if (s === 'deleted') b.push({ key: 'deleted', label: 'Deleted', tone: 'red', note: 'not counted' });
  if (s === 'duplicate') b.push({ key: 'duplicate', label: 'Duplicate', tone: 'grey', note: e.kind === 'photo' || /photo|image|challan/i.test(e.source_label ?? '') ? 'same photo sent again, not counted' : 'same message sent again, not counted' });
  if (s === 'superseded') b.push({ key: 'superseded', label: 'Replaced', tone: 'grey', note: 'a later message changed this' });
  const rb = readByLabel(e);
  if (rb) b.push({ key: 'read_by', label: `Read by ${rb}`, tone: 'grey' });
  return b;
}

/** The agent's role for one event, in plain words. */
export function roleLabel(role?: string | null): { label: string; tone: BadgeTone } | null {
  if (!role) return null;
  const r = role.toLowerCase();
  if (r === 'counts') return { label: 'Counted', tone: 'green' };
  if (r === 'replaced') return { label: 'Replaced by a later message', tone: 'grey' };
  if (r.startsWith('duplicate_of')) return { label: 'Same as an earlier message, not counted', tone: 'grey' };
  if (r === 'ignored') return { label: 'Not counted', tone: 'grey' };
  return { label: role, tone: 'grey' };
}

const CHECK_WORDS: [RegExp, string][] = [
  [/node.*(missing|not.?found|unknown)|unknown.?node|not.?exist/i, 'The agent pointed at a message we could not find.'],
  [/tenant/i, 'The agent pointed at a message from another business.'],
  [/deleted/i, 'A deleted message was counted.'],
  [/duplicate/i, 'The same photo or message was counted twice.'],
  [/ground|not.?in.?text|qty.?not/i, 'A quantity the agent used is not written in that message.'],
  [/total|sum/i, 'The total does not add up from the counted messages.'],
  [/case|po.*(missing|not.?found|exist)/i, 'The order (PO) it linked to does not exist.'],
  [/confidence/i, 'The agent was not sure enough.'],
];
/** Verifier failure codes or sentences -> one plain line each. Unknown text passes through. */
export function plainCheck(c: string): string {
  const t = c.trim();
  if (/\s/.test(t) && /[.!?]$/.test(t) && !/_/.test(t)) return t; // already a sentence
  for (const [re, words] of CHECK_WORDS) if (re.test(t)) return words;
  return t.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
}

/** Money to bill with GST, from the invoice preview (the existing GST code), else from qty × rate at 18%. */
export function billAmounts(opts: { preview?: GstPreview | null; qty?: number | null; rate?: number | null; gstRate?: number }): { pre: number; total: number } | null {
  const p = opts.preview;
  if (p && p.lines?.length) {
    const pre = p.lines.reduce((s, l) => s + (l.taxable ?? l.qty * l.rate), 0);
    return { pre, total: p.total };
  }
  if (opts.qty && opts.rate) {
    const pre = opts.qty * opts.rate;
    return { pre, total: withGst(pre, opts.gstRate) };
  }
  return null;
}
export const withGst = (pre: number, gstRate = 18) => Math.round(pre * (1 + gstRate / 100));

/** Sort by time (oldest first); events without time keep their place at the end. */
export function sortTimeline(t?: TimelineEvent[] | null): TimelineEvent[] {
  return [...(t ?? [])].filter((e) => e && e.node_id).sort((a, b) => (a.at ?? '\uffff').localeCompare(b.at ?? '\uffff'));
}

export const asList = (x?: string[] | string | null): string[] => (Array.isArray(x) ? x.filter(Boolean) : x ? [x] : []);

export function memoryCases(m?: ChatMemory | null, exclude?: string): ChatMemoryCase[] {
  return (m?.cases ?? [])
    .map((c) => (typeof c === 'string' ? { case_ref: c } : c))
    .filter((c) => c && (c.case_ref || c.po_ref) && c.case_ref !== exclude);
}

export function hasDecision(d?: TimelineDecisionSummary | null): d is TimelineDecisionSummary {
  return !!d && (!!d.explanation_for_owner || d.verified != null || (d.failed_checks?.length ?? 0) > 0 || d.delivered_total != null);
}

// ---------------- Agent activity: Timeline agent steps ----------------
export interface TimelineStep { run_id: string; step: number; tool: string; args: string; result: string | null; why: string | null; ok: boolean | null; ts: string }
type Ev = { run_id: string; agent: string; type: string; data?: Record<string, any> | null; ts: string };

/** Short one-line args: `case_ref=RG-1051, total=100`; long values cut. */
export function shortArgs(a: unknown, max = 90): string {
  if (a == null) return '';
  if (typeof a !== 'object') return String(a).slice(0, max);
  const parts = Object.entries(a as Record<string, unknown>).map(([k, v]) => {
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}=${val && val.length > 40 ? val.slice(0, 39) + '…' : val}`;
  });
  const s = parts.join(', ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Pair the Timeline agent's tool_call / tool_result events into steps, oldest first. */
export function timelineSteps(trace: Ev[]): TimelineStep[] {
  const evs = [...(trace ?? [])].filter((e) => e && e.agent === 'timeline').sort((a, b) => a.ts.localeCompare(b.ts));
  const out: TimelineStep[] = [];
  for (const e of evs) {
    const d = e.data ?? {};
    if (e.type === 'tool_call') out.push({ run_id: e.run_id, step: Number(d.step ?? out.length + 1), tool: String(d.tool ?? '?'), args: shortArgs(d.args), result: null, why: d.why ?? null, ok: null, ts: e.ts });
    if (e.type === 'tool_result') {
      const s = [...out].reverse().find((x) => x.run_id === e.run_id && x.tool === String(d.tool) && x.result === null);
      const r = d.summary ?? d.result ?? (d.found ? JSON.stringify(d.found) : null);
      if (s) { s.result = r == null ? null : typeof r === 'string' ? r : JSON.stringify(r); s.ok = d.ok ?? true; }
    }
  }
  return out;
}
