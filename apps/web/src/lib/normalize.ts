// Real-API → UI shape adapters. The UI was built against docs/CONTRACT.md + the mock backend, where a case's id IS
// its human number ("RG-1042"). The FastAPI service keys rows by uuid and exposes `case_number`, `po_ref`, etc.
// Everything returned by the real API passes through here (api.ts), so pages never see the difference.
// Mock mode (NEXT_PUBLIC_MOCK=true) bypasses this file entirely.
import type {
  Approval, AuditRow, CaseDetail, CaseSummary, Connector, Escalation, EvalLatest, MetricsSummary, TriageItem, AgentEvent,
} from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// uuid -> case number, learned from every case/approval payload we see (used for WS events + audit rows)
const caseNumbers = new Map<string, string>();
export function rememberCase(id?: string | null, number?: string | null) {
  if (id && number) caseNumbers.set(id, number);
}
export function caseRef(id?: string | null, number?: string | null): string | null | undefined {
  if (number) return number;
  if (id && caseNumbers.has(id)) return caseNumbers.get(id)!;
  return id;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined);

export function caseSummary(c: Any): CaseSummary {
  if (!c) return c;
  rememberCase(c.id, c.case_number);
  const triage = c.triage ?? {};
  return {
    ...c,
    id: c.case_number ?? c.id,
    uuid: c.id,
    reference: c.reference ?? c.po_ref ?? null,
    amount: num(c.amount) ?? null,
    genuine_prob: c.genuine_prob ?? triage.genuine_prob ?? null,
    needs_review_prob: c.needs_review_prob ?? triage.needs_review_prob ?? null,
  } as CaseSummary;
}

export function approval(a: Any): Approval {
  if (!a) return a;
  const c = a.case ?? {};
  rememberCase(c.id ?? a.case_id, c.case_number ?? a.case_number);
  const prop = a.proposal ?? {};
  const action = prop.action ?? prop.payload ?? {};
  return {
    ...a,
    case_id: caseRef(a.case_id, c.case_number ?? a.case_number) ?? a.case_id,
    amount: num(a.amount) ?? num(action.amount),
    customer: a.customer ?? c.customer ?? action.customer_name,
    action_type: a.action_type ?? action.type,
    approvers: (a.approvers ?? []).map((x: Any) => ({ ...x, decision: x.decision ?? 'approve', ts: x.ts ?? x.at ?? x.approved_at })),
  } as Approval;
}

export function agentEvent(e: Any, caseNumber?: string): AgentEvent {
  return { ...e, case_id: caseNumber ?? caseRef(e.case_id, e.case_number) ?? e.case_id } as AgentEvent;
}

function proposal(p: Any) {
  const chk = p.validation?.check ?? p.validation;
  const validation = chk && typeof chk.ok === 'boolean' ? { ok: chk.ok, errors: chk.errors ?? [], findings: p.validation?.findings } : undefined;
  return { ...p, validation };
}

export function caseDetail(d: Any): CaseDetail {
  if (!d?.case) return d;
  const cs = caseSummary(d.case);
  const id = cs.id;
  const f = d.facts ?? null;
  const bill = f?.billable ?? {};
  // once the case has written its invoice, the validator's *remaining* billable is 0; show what was billable when
  // the executed proposal was validated (the validator's corrected action at approval time) instead
  const executed = (d.actions ?? []).some((a: Any) => a.status === 'succeeded');
  const atApproval = executed ? d.proposal?.validation?.check?.corrected_action : null;
  const facts = f
    ? {
        ...f,
        ref_normalized: f.ref_normalized ?? f.po_ref,
        order_qty: num(f.order_qty),
        delivered_qty: num(f.delivered_qty),
        rate: num(f.rate),
        rule: typeof f.rule === 'object' ? f.rule?.mode : f.rule,
        billable_qty: atApproval ? num(atApproval.line_items?.[0]?.qty) : num(f.billable_qty) ?? num(bill.billable_qty),
        billable_amount: atApproval ? num(atApproval.amount) : num(f.billable_amount) ?? num(bill.amount),
        duplicates: (f.duplicates ?? []).map((x: Any) => (typeof x === 'string' ? x : x.invoice_number ?? x.invoice_id)),
        check: f.check ?? d.proposal?.validation?.check,
      }
    : null;
  const v = d.verification;
  const verification = v
    ? {
        ...v,
        status: v.status === 'pass' ? 'passed' : v.status === 'fail' ? 'failed' : v.status,
        checks: (v.checks ?? []).map((c: Any) => ({ ...c, name: c.name ?? c.field })),
        ts: v.ts ?? v.created_at,
        target_id: v.target_id ?? v.read_back?.invoice_number ?? v.read_back?.invoice_id,
      }
    : null;
  return {
    ...d,
    case: cs,
    facts,
    // API `untrusted_flag` = "came from an external source" (nearly everything); the UI uses it for content that was
    // actually flagged (quarantined / injection-like), which is what the context & quarantine lane shows.
    evidence: {
      nodes: (d.evidence?.nodes ?? []).map((n: Any) => {
        const verdict = String(n.fields?.alt_search_verdict ?? n.fields?.verdict ?? '');
        return { ...n, external_source: n.untrusted_flag, untrusted_flag: !!n.quarantined || (typeof n.injection_prob === 'number' && n.injection_prob >= 0.5), ruled_out: n.ruled_out ?? verdict.startsWith('ruled_out') };
      }),
      edges: d.evidence?.edges ?? [],
    },
    agent_runs: (d.agent_runs ?? []).map((r: Any) => ({
      ...r, run_id: r.run_id ?? r.id, provider: r.provider ?? (r.runner === 'harness' ? undefined : r.runner), attempts: r.attempts,
    })),
    checkpoints: (d.checkpoints ?? []).map((c: Any) => ({ ...c, ts: c.ts ?? c.created_at, payload: { ...(c.payload ?? {}), reason: c.payload?.reason ?? c.reason } })),
    proposal: d.proposal ? proposal(d.proposal) : null,
    approvals: (d.approvals ?? []).map((a: Any) => approval({ ...a, case: { id: d.case.id, case_number: d.case.case_number, customer: d.case.customer } })),
    actions: (d.actions ?? []).map((a: Any) => ({
      ...a, case_id: id, ts: a.ts ?? a.created_at, detail: a.detail ?? a.error ?? (a.response?.invoice_number ? `invoice ${a.response.invoice_number}` : undefined),
    })),
    verification,
    laya: d.laya ?? null,
  } as CaseDetail;
}

export function auditRow(r: Any): AuditRow {
  const data = r.data ?? r.detail;
  return {
    ...r,
    id: String(r.id ?? r.seq),
    ts: r.ts ?? r.created_at,
    case_id: caseRef(r.case_id, r.case_number) ?? null,
    action: r.action ?? r.event,
    detail: data,
    state_from: r.state_from ?? data?.from ?? data?.from_state ?? null,
    state_to: r.state_to ?? data?.to ?? data?.to_state ?? null,
  } as AuditRow;
}

export function escalation(e: Any): Escalation {
  rememberCase(e.case_id, e.case_number);
  const det = e.detail;
  return {
    ...e,
    case_id: e.case_number ?? e.case_id,
    detail: typeof det === 'string' ? det : det?.message ?? (det ? JSON.stringify(det) : undefined),
  } as Escalation;
}

export function triageItem(t: Any): TriageItem {
  rememberCase(t.case_id, t.case_number);
  const tr = t.triage ?? {};
  return {
    ...t,
    case_id: t.case_number ?? t.case_id,
    title: t.title ?? tr.summary?.slice(0, 90) ?? t.case_number,
    excerpt: t.excerpt ?? tr.summary,
    predicted: t.predicted ?? { exception_type: tr.exception_type, severity: tr.severity },
    laya: t.laya ?? tr.laya ?? null,
    status: t.status === 'open' ? 'pending' : t.status,
  } as TriageItem;
}

const GOOGLE = ['gmail', 'sheets', 'drive'];
export function connectors(raw: Any): Connector[] {
  const list: Any[] = Array.isArray(raw) ? raw : raw?.connectors ?? raw?.items ?? [];
  const out: Connector[] = list.map((c) => ({
    ...c,
    account: c.account ?? c.authorized_by ?? null,
    last_sync: c.last_sync ?? c.last_sync_at ?? null,
    detail: c.detail ?? c.error ?? (c.mode === 'mock' ? 'demo adapter (DEMO_MODE)' : c.mode === 'live' ? 'live' : null),
  }));
  // the UI shows one Google card for the single OAuth grant covering Gmail + Sheets + Drive
  if (!out.some((c) => c.name === 'google')) {
    const g = out.filter((c) => GOOGLE.includes(c.name));
    if (g.length) {
      const all = g.every((c) => c.status === 'connected');
      const gmail = g.find((c) => c.name === 'gmail') ?? g[0];
      out.unshift({ ...gmail, name: 'google', status: all ? 'connected' : gmail.status, detail: g.map((c) => `${c.name}: ${c.status}`).join(' · ') });
    }
  }
  return out;
}

const val = (m: Any, k: string): number | null => {
  const x = m?.[k];
  if (typeof x === 'number') return x;
  if (x && typeof x === 'object' && typeof x.value === 'number') return x.value;
  return null;
};

export function evalLatest(e: Any): EvalLatest {
  if (!e || Array.isArray(e?.approaches)) return e;
  const ap = e.approaches ?? {};
  const names = Object.keys(ap);
  const approaches = names.map((name) => {
    const m = ap[name]?.metrics ?? ap[name] ?? {};
    const n = e.n_cases || 1;
    return {
      name,
      precision: val(m, 'exception_precision'), recall: val(m, 'exception_recall'), fpr: val(m, 'false_positive_rate'),
      evidence_coverage: val(m, 'evidence_coverage'), useful_next_check_rate: val(m, 'useful_next_check_rate'),
      verified_resolution_rate: val(m, 'verified_resolution_rate'), outcome_accuracy: val(m, 'outcome_accuracy'),
      unsafe_writes: num(m.unsafe_writes) ?? null, duplicate_writes: num(m.duplicate_writes) ?? null,
      p50_s: num(m.latency_ms?.p50) != null ? +(m.latency_ms.p50 / 1000).toFixed(2) : null,
      p95_s: num(m.latency_ms?.p95) != null ? +(m.latency_ms.p95 / 1000).toFixed(2) : null,
      cost_inr: num(m.model_cost_inr?.total) != null ? +(m.model_cost_inr.total / n).toFixed(2) : null,
      tool_calls_per_case: num(m.tool_calls_per_case?.median) ?? null,
    };
  });
  const scen = new Set<string>();
  for (const n of names) Object.keys(ap[n]?.metrics?.per_scenario ?? {}).forEach((s) => scen.add(s));
  const by_scenario = [...scen].map((s) => {
    const row: Any = { scenario: s };
    for (const n of names) {
      const p = ap[n]?.metrics?.per_scenario?.[s];
      row[n] = typeof p?.value === 'number' ? p.value : 0;
      row.n = row.n ?? p?.denominator;
    }
    return row;
  });
  return { ...e, approaches, by_scenario, dataset: e.dataset ?? `synthetic labelled set · split=${e.split ?? 'all'}`, run_id: e.run_id ?? e.generated_at, synthetic: true };
}

/** Live ops metrics from /metrics/summary, with quality figures taken from the latest eval's adaptive approach. */
export function metricsSummary(m: Any, ev?: Any): MetricsSummary {
  const e = ev ? evalLatest(ev) : null;
  const adaptive: Any = (e?.approaches as Any[] | undefined)?.find((a: Any) => a.name === 'adaptive') ?? {};
  const vr = m?.verified_resolution_rate;
  const live = vr && typeof vr === 'object' && vr.denominator ? vr.numerator / vr.denominator : undefined;
  const cases = m?.cases?.total || 0;
  return {
    ...m,
    precision: adaptive.precision, recall: adaptive.recall, fpr: adaptive.fpr,
    evidence_coverage: adaptive.evidence_coverage, useful_next_check_rate: adaptive.useful_next_check_rate,
    verified_resolution_rate: live ?? adaptive.verified_resolution_rate,
    unsafe_writes: adaptive.unsafe_writes ?? 0,
    duplicate_writes: m?.actions?.duplicate_writes ?? 0,
    latency_p50_s: m?.case_duration_seconds?.p50 ?? null,
    latency_p95_s: m?.case_duration_seconds?.p95 ?? null,
    cost_per_case_inr: cases ? +((m?.agent_runs?.cost_inr ?? 0) / cases).toFixed(2) : null,
  };
}
