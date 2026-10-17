// Typed API client for docs/CONTRACT.md. In mock mode (NEXT_PUBLIC_MOCK=true) every call is
// served by the in-browser mock backend with the same paths, bodies and response shapes.
import { API_URL, isDemo } from './config';
import * as N from './normalize';
import type * as V from './v2types';
import type {
  Approval, AuditRow, CaseDetail, CaseSummary, Connector, Escalation, EvalLatest, LoginResponse,
  MetricsSummary, AgentEvent, TriageItem, User, ResolutionAction, ExceptionType, Severity,
} from './types';

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, message: string, body?: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

let tokenGetter: () => string | null = () => null;
export function setTokenGetter(fn: () => string | null) { tokenGetter = fn; }
export function currentToken() { return tokenGetter(); }

type Method = 'GET' | 'POST' | 'PUT';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const token = tokenGetter();
  if (isDemo()) {
    const { mockBackend } = await import('./mock/backend');
    return mockBackend().handle(method, path, body, token) as Promise<T>;
  }
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(API_URL + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.detail?.message || data.detail || data.message)) || `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, typeof msg === 'string' ? msg : JSON.stringify(msg), data);
  }
  return data as T;
}

const qs = (o: Record<string, string | undefined | null>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? '?' + p.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
};

// the API wraps lists ({cases:[…]}, {approvals:[…]}, {entries:[…]}, {events:[…]} …); accept any of them
const LIST_KEYS = ['items', 'cases', 'approvals', 'connectors', 'escalations', 'entries', 'events', 'rows', 'audit'];
const list = <T,>(x: any): T[] => {
  if (Array.isArray(x)) return x;
  for (const k of LIST_KEYS) if (Array.isArray(x?.[k])) return x[k];
  return [];
};
// real API -> UI shapes (identity in mock mode, where the mock backend already speaks the UI shapes)
const real = <T,>(fn: (x: any) => T) => (x: any): T => (isDemo() ? x : fn(x));

export const api = {
  login: (email: string, password: string) => request<LoginResponse>('POST', '/auth/login', { email, password }),
  me: () => request<User>('GET', '/me'),

  cases: async (f: { status?: string; severity?: string; q?: string } = {}) =>
    list<any>(await request('GET', '/cases' + qs(f))).map(real(N.caseSummary)),
  case: async (id: string) => real(N.caseDetail)(await request<any>('GET', `/cases/${encodeURIComponent(id)}`)),
  trace: async (id: string) => list<any>(await request('GET', `/cases/${encodeURIComponent(id)}/trace`)).map(real((e) => N.agentEvent(e, id))),

  approvals: async (status?: string) => list<any>(await request('GET', '/approvals' + qs({ status }))).map(real(N.approval)),
  approve: async (id: string, comment: string) => real(N.approval)(await request<any>('POST', `/approvals/${id}/approve`, { comment })),
  reject: async (id: string, reason: string) => real(N.approval)(await request<any>('POST', `/approvals/${id}/reject`, { reason })),
  edit: (id: string, action: ResolutionAction, reason: string) => request<any>('POST', `/approvals/${id}/edit`, { action, reason }),

  connectors: async () => (isDemo() ? list<Connector>(await request('GET', '/connectors')) : N.connectors(await request('GET', '/connectors'))),
  whatsappQr: () => request<{ qr: string | null; state?: string }>('GET', '/connectors/whatsapp/qr'),
  revoke: (name: string) => request<any>('POST', `/connectors/${name}/revoke`),
  bankUpload: (file: File) => { const fd = new FormData(); fd.append('file', file); return request<any>('POST', '/connectors/bank/upload', fd); },
  sheetsConfig: (spreadsheet_id: string, range: string) => request<any>('POST', '/connectors/sheets/config', { spreadsheet_id, range }),
  oauthStartUrl: (name: 'google' | 'zoho') => `${API_URL}/connectors/${name}/start${qs({ token: tokenGetter() })}`,
  mockConnect: (name: string) => request<any>('POST', `/connectors/${name}/mock-connect`), // mock backend, or real API with DEMO_MODE=true

  triageQueue: async () => list<any>(await request('GET', '/triage-queue')).map(real(N.triageItem)),
  label: (id: string, exception_type: ExceptionType, severity: Severity) =>
    request<any>('POST', `/triage-queue/${id}/label`, { exception_type, severity }),

  escalations: async () => list<any>(await request('GET', '/escalations')).map(real(N.escalation)),
  resolveEscalation: (id: string) => request<any>('POST', `/escalations/${id}/resolve`),

  audit: async (f: { case_id?: string; correlation_id?: string } = {}) => list<any>(await request('GET', '/audit' + qs(f))).map(real(N.auditRow)),

  metrics: async () => {
    if (isDemo()) return request<MetricsSummary>('GET', '/metrics/summary');
    const [m, ev] = await Promise.all([request<any>('GET', '/metrics/summary'), request<any>('GET', '/eval/latest').catch(() => null)]);
    return N.metricsSummary(m, ev);
  },
  evalLatest: async () => N.evalLatest(await request<any>('GET', '/eval/latest')) as EvalLatest,

  demoReset: () => request<any>('POST', '/demo/reset'),
  demoReplay: () => request<any>('POST', '/demo/replay'),
  demoStep: (n: number) => request<any>('POST', `/demo/step/${n}`),
  demoChaos: (kind: string) => request<any>('POST', `/demo/chaos/${kind}`),
  fastForward: (hours: number) => request<any>('POST', '/demo/fast-forward', { hours }),
  demoSpeed: (speed: number) => request<any>('POST', '/demo/speed', { speed }),
  demoStatus: () => request<{ scenes_done: number[]; speed: number }>('GET', '/demo/status'), // real API only
  killSwitch: (enabled: boolean) => request<any>('POST', '/admin/kill-switch', { enabled }),
  eventsRecent: async () => list<any>(await request('GET', '/events/recent')),

  // ---------------- v2 business layer (docs/CONTRACT_V2.md) ----------------
  dashboard: (period: 'month' | '30d' | 'quarter' = 'month') => request<V.DashboardSummary>('GET', '/dashboard/summary' + qs({ period })),
  bill: async (f: { status?: string; customer?: string; q?: string } = {}) => {
    const r = await request<any>('GET', '/bill' + qs(f));
    return { items: list<V.ToBillRow>(r), total_amount: Number(r?.total_amount ?? 0), not_billable: (r?.not_billable ?? []) as { po_ref: string; customer: string; reason: string; note: string; at: string }[] };
  },
  notBillable: (case_ref: string, reason: string, note: string) => request<{ ok: boolean }>('POST', `/bill/${encodeURIComponent(case_ref)}/not-billable`, { reason, note }),
  collect: async (bucket = 'all') => {
    const r = await request<any>('GET', '/collect' + qs({ bucket }));
    return { items: list<V.ChaseRow>(r), total_amount: Number(r?.total_amount ?? 0) };
  },
  snooze: (inv: string, days: number, reason: string) => request<{ ok: boolean; snoozed_until: string }>('POST', `/collect/${encodeURIComponent(inv)}/snooze`, { days, reason }),
  draftReminder: (inv: string, stage: number) => request<V.ApprovalCard>('POST', `/collect/${encodeURIComponent(inv)}/draft-reminder`, { stage }),
  caseSummary: (ref: string, lang?: string) => request<V.CaseSummaryV2>('GET', `/cases/${encodeURIComponent(ref)}/summary` + qs({ lang: lang && lang !== 'en' ? lang : undefined })),
  correctFact: (ref: string, factId: string, value: string, note: string) =>
    request<{ ok: boolean; evidence_version: number }>('POST', `/cases/${encodeURIComponent(ref)}/facts/${encodeURIComponent(factId)}/correct`, { value, note }),
  approvalCards: async (status?: string) => {
    const items = list<any>(await request('GET', '/approvals' + qs({ status })));
    return items.map((a) => ({ ...(a.card ?? {}), id: a.card?.id ?? a.id, status: a.status, created_at: a.created_at, expires_reason: a.card?.expires_reason ?? a.expires_reason ?? null })) as V.ApprovalCard[];
  },
  bulkApprove: (ids: string[]) => request<{ results: { id: string; ok: boolean; detail: string }[] }>('POST', '/approvals/bulk-approve', { ids }),
  customers: async () => list<V.CustomerRow>(await request('GET', '/customers')),
  customer: (id: string) => request<V.CustomerDetail>('GET', `/customers/${encodeURIComponent(id)}`),
  unlinked: async () => {
    const r = await request<any>('GET', '/unlinked');
    return { items: list<V.UnlinkedItem>(r), sorted: (r?.sorted ?? []) as V.SortedItem[] };
  },
  linkUnlinked: (id: string, case_ref: string) => request<{ ok: boolean }>('POST', `/unlinked/${encodeURIComponent(id)}/link`, { case_ref }),
  ignoreUnlinked: (id: string) => request<{ ok: boolean }>('POST', `/unlinked/${encodeURIComponent(id)}/ignore`),
  aliases: async () => list<{ kind: string; alias: string; canonical: string }>(await request('GET', '/aliases')),
  reports: (from?: string, to?: string) => request<V.ReportsSummary>('GET', '/reports/summary' + qs({ from, to })),
  reportCsv: async (from?: string, to?: string): Promise<string> => {
    const path = '/reports/export' + qs({ from, to, format: 'csv' });
    if (isDemo()) {
      const { mockBackend } = await import('./mock/backend');
      return mockBackend().handle('GET', path, undefined, tokenGetter()) as Promise<string>;
    }
    const token = tokenGetter();
    const res = await fetch(API_URL + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new ApiError(res.status, 'Could not make the export. Please try again in a minute.');
    return res.text();
  },
  settings: async () => {
    // live API keeps per-user notification prefs on their own endpoint; merge them (with safe defaults) into Settings
    const st = await request<V.Settings>('GET', '/settings');
    let n: any = st.notifications;
    if (!n) { try { n = await request<any>('GET', '/settings/notifications'); } catch { n = null; } }
    const d = { approvals: true, digest: false, receipts: true, problems: true, quiet_hours: { from: '22:00', to: '07:00' } };
    return { ...st, notifications: { ...d, ...(n ?? {}), quiet_hours: { ...d.quiet_hours, ...(n?.quiet_hours ?? {}) } } } as V.Settings;
  },
  saveSettings: (partial: Partial<V.Settings>) => request<V.Settings>('PUT', '/settings', partial),
  team: async () => list<V.TeamMember>(await request('GET', '/settings/team')),
  saveNotifications: (n: NonNullable<V.Settings['notifications']>) => request<any>('PUT', '/settings/notifications', n),
  setPhone: (phone: string) => request<any>('PUT', '/me/phone', { phone }),
  connectorsV2: async () => list<V.ConnectorV2>(await request('GET', '/connectors')),
  waChats: async () => list<V.WaChat>(await request('GET', '/connectors/whatsapp/chats')),
  setWaChats: (watched: string[]) => request<any>('PUT', '/connectors/whatsapp/chats', { watched }),
  proposeMapping: (sheet_id: string, tab: string) => request<{ columns: V.SheetColumn[]; rows?: number; title?: string }>('POST', '/connectors/sheets/propose-mapping', { sheet_id, tab }),
  saveSheetConfig: (spreadsheet_id: string, range: string, mapping: Record<string, string>) => request<any>('POST', '/connectors/sheets/config', { spreadsheet_id, range, mapping }),
  startBackfill: (days = 90) => request<{ job_id: string }>('POST', '/setup/backfill', { days }),
  backfill: () => request<V.Backfill>('GET', '/setup/backfill'),
  ask: (question: string, lang?: string) => request<V.AskAnswer>('POST', '/ask', { question, lang }),
};
