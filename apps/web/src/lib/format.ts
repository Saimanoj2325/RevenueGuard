import type { CaseDetail, CaseState, Facts } from './types';

export const inr = (n?: number | null) =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : '₹' + Math.round(n).toLocaleString('en-IN');

export const pct = (n?: number | null, d = 1) => (n === null || n === undefined ? '—' : (n * 100).toFixed(d) + '%');

export function ago(iso?: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const raw = Math.round((now - new Date(iso).getTime()) / 1000);
  const s = Math.abs(raw);
  const v = s < 45 ? '' : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  if (!v) return 'just now';
  return raw < 0 ? `in ${v}` : `${v} ago`;
}

export const clock = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : '—';

export const dateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : '—';

export const human = (s?: string | null) => (s ? s.replace(/_/g, ' ') : '—');

export const shortHash = (h?: string | null, n = 10) => {
  if (!h) return '—';
  const [p, rest] = h.includes(':') ? h.split(':') : ['', h];
  return (p ? p + ':' : '') + rest.slice(0, n) + '…' + rest.slice(-4);
};

export const stateTone = (s: CaseState): 'ink' | 'amber' | 'red' | 'green' | 'blue' => {
  if (s === 'CLOSED') return 'green';
  if (s === 'BLOCKED' || s === 'ESCALATED') return 'red';
  if (s === 'PAUSED' || s === 'AWAITING_APPROVAL') return 'amber';
  if (s === 'EXECUTING' || s === 'VERIFYING') return 'blue';
  return 'ink';
};

/** Validator facts: explicit `facts` field (ext) or the latest checkpoint payload that carries facts. */
export function factsOf(d: CaseDetail): Facts | null {
  if (d.facts) return d.facts;
  for (let i = d.checkpoints.length - 1; i >= 0; i--) if (d.checkpoints[i].payload?.facts) return d.checkpoints[i].payload!.facts;
  return null;
}

export function argmax(p?: Record<string, number> | null): [string, number] | null {
  if (!p) return null;
  const e = Object.entries(p).sort((a, b) => b[1] - a[1])[0];
  return e ? [e[0], e[1]] : null;
}

// ---------------- Indian formats (v2) ----------------
const TZ = 'Asia/Kolkata';
/** 15 Oct 2026 */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dateIN = (iso?: string | null, withYear = true) => {
  if (!iso) return '—';
  const p = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: TZ }).formatToParts(new Date(iso));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return `${g('day')} ${MON[g('month') - 1]}${withYear ? ' ' + g('year') : ''}`;
};
/** 15 Oct */
export const dayMonth = (iso?: string | null) => dateIN(iso, false);
/** 9:18 PM */
export const timeIN = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ }) : '—';
/** Thursday, 15 Oct */
export const weekdayIN = (d = new Date()) => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: TZ });
/** "Today 9:12 PM" / "Yesterday" / "13 Oct" */
export function whenIN(iso?: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const key = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });
  if (key(d.getTime()) === key(now)) return 'Today ' + timeIN(iso);
  if (key(d.getTime()) === key(now - 86400e3)) return 'Yesterday';
  return dayMonth(iso);
}
/** short relative: "2 min ago", "yesterday" */
export function minsAgo(iso?: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 50) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  if (s < 2 * 86400) return 'yesterday';
  return dayMonth(iso);
}
/** 4,82,000 without the rupee sign */
export const inrPlain = (n?: number | null) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString('en-IN'));
/** ₹4.8 lakh / ₹1.2 crore (compact) */
export function inrShort(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return '₹' + +(n / 1e7).toFixed(2) + ' crore';
  if (a >= 1e5) return '₹' + +(n / 1e5).toFixed(2) + ' lakh';
  return inr(n);
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n: number) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''));
const three = (n: number) => (n >= 100 ? ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + two(n % 100) : '') : two(n));
/** Indian system words: 82600 -> "Rupees Eighty Two Thousand Six Hundred Only" */
export function rupeesInWords(n: number): string {
  n = Math.round(n);
  if (n === 0) return 'Rupees Zero Only';
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(three(crore) + ' Crore');
  if (lakh) parts.push(two(lakh) + ' Lakh');
  if (thousand) parts.push(two(thousand) + ' Thousand');
  if (n) parts.push(three(n));
  return 'Rupees ' + parts.join(' ') + ' Only';
}
/** mask a phone: +91 98••• ••210 */
export function maskPhone(p?: string | null) {
  if (!p) return '—';
  const d = p.replace(/\D/g, '');
  return `+91 ${d.slice(-10, -8)}••• ••${d.slice(-3)}`;
}

/** "919876543204" -> "+91 98765 43204"; other country codes -> "+CC NNNN NNNN…". Null when it is not a phone number. */
export function formatPhone(digits?: string | null): string | null {
  const d = (digits ?? '').replace(/\D/g, '');
  if (d.length < 8 || d.length > 15) return null;
  if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 5)} ${d.slice(5)}`;
  if (d.length === 11 && d.startsWith('1')) return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  const cc = d.length > 10 ? d.slice(0, d.length - 10) : '';
  const rest = d.slice(cc.length);
  return (cc ? `+${cc} ` : '+') + rest.replace(/(\d{3,4})(?=\d{3})/g, '$1 ').trim();
}
