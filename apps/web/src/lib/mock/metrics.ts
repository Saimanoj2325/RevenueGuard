// Mock /metrics/summary and /eval/latest. Numbers are a synthetic eval fixture (labelled, 160 cases),
// clearly marked as such in the UI — not measured product performance.
export function metricsSummary(db: { cases: Record<string, any>; audit: any[]; usedIdempotency: string[] }) {
  const cases = Object.values(db.cases).map((d: any) => d.case);
  const by = (s: string) => cases.filter((c: any) => c.state === s).length;
  const guard = db.audit.filter((r) => String(r.action).startsWith('guardrail.'));
  return {
    window: 'last 7 days (demo tenant)',
    cases_total: cases.length,
    cases_open: cases.filter((c: any) => c.state !== 'CLOSED').length,
    cases_closed: by('CLOSED'),
    cases_escalated: by('ESCALATED'),
    awaiting_approval: by('AWAITING_APPROVAL'),
    precision: 0.912, recall: 0.874, fpr: 0.061,
    evidence_coverage: 0.968, useful_next_check_rate: 0.81, verified_resolution_rate: 0.957,
    unsafe_writes: 0, duplicate_writes: 0,
    gateway_writes: db.usedIdempotency.length,
    guardrail_events: guard.length,
    guardrails_by_kind: guard.reduce((m: Record<string, number>, r: any) => { const k = r.action.slice(10); m[k] = (m[k] ?? 0) + 1; return m; }, {}),
    latency_p50_s: 41.2, latency_p95_s: 118.6, cost_per_case_inr: 2.84,
    provider_mix: { nim: 0.86, groq: 0.12, ollama: 0.02 },
  };
}

export function evalLatest() {
  const approaches = [
    { name: 'rules_only', label: 'Rules-only', precision: 0.78, recall: 0.61, fpr: 0.142, evidence_coverage: 0.71, useful_next_check_rate: null, verified_resolution_rate: 0.83, unsafe_writes: 0, duplicate_writes: 2, p50_s: 1.4, p95_s: 3.1, cost_inr: 0 },
    { name: 'fixed_sequence', label: 'Fixed-sequence LLM', precision: 0.86, recall: 0.8, fpr: 0.094, evidence_coverage: 0.9, useful_next_check_rate: 0.52, verified_resolution_rate: 0.9, unsafe_writes: 0, duplicate_writes: 0, p50_s: 63.5, p95_s: 171.0, cost_inr: 4.92 },
    { name: 'adaptive', label: 'Adaptive (RevenueGuard)', precision: 0.912, recall: 0.874, fpr: 0.061, evidence_coverage: 0.968, useful_next_check_rate: 0.81, verified_resolution_rate: 0.957, unsafe_writes: 0, duplicate_writes: 0, p50_s: 41.2, p95_s: 118.6, cost_inr: 2.84 },
  ];
  const scen = ['missing_invoice', 'alt_reference', 'billing_not_due', 'partial_delivery', 'duplicate_invoice', 'partial_payment', 'quantity_conflict', 'injection', 'connector_timeout', 'stale_approval'];
  const n = [24, 18, 14, 22, 12, 16, 14, 12, 14, 14];
  const base = [0.92, 0.89, 0.93, 0.9, 0.97, 0.88, 0.79, 1.0, 0.93, 1.0];
  return {
    run_id: 'eval_2026-10-15T06:00Z', ts: '2026-10-15T06:00:00Z', dataset: 'synthetic-v1 (held-out test split)', n_cases: 160,
    synthetic: true,
    approaches,
    by_scenario: scen.map((s, i) => ({
      scenario: s, n: n[i],
      rules_only: +(base[i] - 0.18 - (i % 3) * 0.05).toFixed(2),
      fixed_sequence: +(base[i] - 0.07 - (i % 2) * 0.03).toFixed(2),
      adaptive: base[i],
    })),
  };
}
