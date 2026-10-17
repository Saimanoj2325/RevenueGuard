// Types mirror docs/CONTRACT.md. Fields marked "ext" are UI-tolerated extensions:
// optional, rendered when present, never required from the real API.

export type Role = 'viewer' | 'operator' | 'finance_approver' | 'admin';

export interface User {
  id: string;
  email: string;
  name?: string;
  role: Role;
  tenant_id?: string;
}
export interface LoginResponse { token: string; user: User }

export const MAIN_STATES = [
  'INTAKE', 'TRIAGED', 'WATCHING', 'EVIDENCE_READY', 'VALIDATED', 'INVESTIGATING',
  'PROPOSED', 'AWAITING_APPROVAL', 'EXECUTING', 'VERIFYING', 'CLOSED',
] as const;
export const SIDE_STATES = ['PAUSED', 'ESCALATED', 'BLOCKED'] as const;
export type MainState = (typeof MAIN_STATES)[number];
export type SideState = (typeof SIDE_STATES)[number];
export type CaseState = MainState | SideState;

export type ExceptionType =
  | 'missing_invoice' | 'partial_delivery' | 'duplicate_invoice' | 'partial_payment'
  | 'quantity_conflict' | 'billing_not_due' | 'none';
export const EXCEPTION_TYPES: ExceptionType[] = [
  'missing_invoice', 'partial_delivery', 'duplicate_invoice', 'partial_payment', 'quantity_conflict', 'billing_not_due', 'none',
];
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];

export type Source = 'gmail' | 'whatsapp' | 'sheets' | 'drive' | 'zoho' | 'bank' | 'media';
export type Stage = 'order' | 'delivery' | 'invoice' | 'payment';
export const STAGES: Stage[] = ['order', 'delivery', 'invoice', 'payment'];
export type StageStatus = 'found' | 'missing' | 'partial' | 'conflict';

export interface LayaAnswer { value: unknown; probs?: Record<string, number> }
export interface LayaResult {
  answers: Record<string, LayaAnswer>;
  model?: string;
  latency_ms?: number;
  fallback?: boolean;
}

export interface CaseSummary {
  id: string;
  state: CaseState;
  customer?: string | null;
  customer_id?: string | null;
  reference?: string | null; // PO ref
  amount?: number | null;
  exception_type?: ExceptionType | null;
  severity?: Severity | null;
  genuine_prob?: number | null;
  needs_review_prob?: number | null;
  correlation_id?: string;
  evidence_version?: number;
  summary?: string | null;
  created_at?: string;
  updated_at?: string;
  severity_probs?: Record<string, number> | null; // ext
}

export interface TimelineEntry { stage: Stage; status: StageStatus; evidence_node_ids: string[]; note?: string }

export interface EvidenceNode {
  id: string;
  kind: string;
  source: Source;
  source_id: string;
  ts: string;
  title: string;
  excerpt?: string;
  fields?: Record<string, unknown>;
  media_url?: string | null;
  untrusted_flag?: boolean;
  derived_text?: string | null; // ext
  ruled_out?: boolean; // ext: decoy evidence considered and rejected
}
export interface EvidenceEdge { from: string; to: string; label?: string }

export type AgentName = 'triage' | 'evidence' | 'investigation' | 'resolution' | 'timeline';
export type AgentEventType =
  | 'step_started' | 'tool_call' | 'tool_result' | 'model_call' | 'step_finished' | 'run_finished' | 'run_failed';
export interface AgentEvent {
  run_id: string;
  case_id: string;
  type: AgentEventType;
  agent: AgentName;
  data: Record<string, any>;
  ts: string;
}
export interface AgentRun {
  run_id: string;
  agent: AgentName;
  status: 'running' | 'finished' | 'failed';
  started_at?: string;
  finished_at?: string;
  provider?: Provider;
  output?: any;
  attempts?: number;
}
export interface Checkpoint { seq: number; state: CaseState; evidence_version: number; ts: string; payload?: Record<string, any> }

export interface LineItem { item: string; qty: number; rate: number }
export interface ResolutionAction {
  type: 'create_invoice' | 'send_reminder' | 'none';
  customer_id?: string;
  customer_name?: string;
  reference?: string;
  line_items: LineItem[];
  amount: number;
  message?: string;
  channel?: 'whatsapp' | 'gmail';
}
export interface Claim { text: string; evidence_node_ids: string[] }
export interface Proposal {
  id: string;
  version?: number;
  action: ResolutionAction;
  claims: Claim[];
  uncertainty: string[];
  risk: 'low' | 'medium' | 'high';
  validation?: { ok: boolean; errors?: string[] }; // ext
  created_at?: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'partially_approved';
export interface Approver { user_id?: string; email: string; role?: Role; decision?: 'approve' | 'reject'; comment?: string; ts?: string }
export interface Approval {
  id: string;
  case_id: string;
  proposal_id: string;
  payload_hash: string;
  evidence_version: number;
  status: ApprovalStatus;
  required_approvers: number;
  approvers: Approver[];
  expires_reason?: string | null;
  created_at?: string; // ext
  amount?: number; // ext
  customer?: string; // ext
  action_type?: string; // ext
}

export interface ActionRecord {
  id: string;
  case_id: string;
  approval_id?: string;
  type: string;
  status: 'pending' | 'succeeded' | 'failed' | 'blocked';
  idempotency_key?: string;
  target_id?: string | null;
  target_system?: string;
  ts?: string;
  detail?: string;
}
export interface VerificationCheck { name: string; expected?: unknown; actual?: unknown; ok: boolean | null }
export interface Verification { status: 'pending' | 'passed' | 'failed'; checks: VerificationCheck[]; ts?: string; target_id?: string }

export interface Facts {
  ref_normalized?: string;
  ref_variants?: string[];
  order_qty?: number;
  delivered_qty?: number;
  rate?: number;
  rule?: string;
  billable_qty?: number;
  billable_amount?: number;
  duplicates?: string[];
  evidence_version?: number;
  check?: { amount_matches?: boolean; claims_cited?: boolean; errors?: string[] };
}

export interface CaseDetail {
  case: CaseSummary;
  timeline: TimelineEntry[];
  evidence: { nodes: EvidenceNode[]; edges: EvidenceEdge[] };
  agent_runs: AgentRun[];
  checkpoints: Checkpoint[];
  proposal: Proposal | null;
  approvals: Approval[];
  actions: ActionRecord[];
  verification: Verification | null;
  laya: LayaResult | null;
  facts?: Facts | null; // ext; falls back to latest VALIDATED checkpoint payload.facts
}

export type ConnectorName = 'google' | 'whatsapp' | 'zoho' | 'sheets' | 'bank' | 'drive' | string;
export interface Connector {
  name: ConnectorName;
  status: 'connected' | 'disconnected' | 'degraded' | 'pairing' | 'error' | string;
  account?: string | null;
  detail?: string | null;
  last_sync?: string | null;
  scopes?: string[];
  config?: Record<string, unknown>;
}

export interface TriageItem {
  id: string;
  case_id?: string | null;
  source?: Source | string;
  title?: string;
  excerpt?: string;
  predicted?: { exception_type?: ExceptionType; severity?: Severity };
  confidence?: number;
  laya?: LayaResult | null;
  created_at?: string;
  status?: 'pending' | 'labeled';
}

export interface Escalation {
  id: string;
  case_id: string;
  reason: string;
  detail?: string;
  status?: 'open' | 'resolved';
  created_at?: string;
}

export interface AuditRow {
  id: string;
  ts: string;
  case_id?: string | null;
  correlation_id?: string | null;
  actor: string;
  action: string;
  detail?: string | Record<string, unknown> | null;
  state_from?: string | null;
  state_to?: string | null;
}

export interface MetricsSummary { [k: string]: any }
export interface EvalLatest { [k: string]: any }

export type Provider = 'nim' | 'groq' | 'ollama';
export type GuardrailKind =
  | 'injection' | 'role_block' | 'duplicate_block' | 'approval_expired' | 'paused' | 'fallback' | 'escalated'
  | (string & {});

export type WsEvent =
  | { type: 'case.updated'; case_id: string; state: CaseState }
  | { type: 'agent.event'; case_id: string; event: AgentEvent } // normalized client-side, see normalizeWs()
  | { type: 'checkpoint'; case_id: string; state: CaseState; seq: number }
  | { type: 'approval.updated'; approval: Approval }
  | { type: 'connector.updated'; name: string; status: string }
  | { type: 'wa.qr'; qr: string }
  | { type: 'guardrail'; case_id: string; kind: GuardrailKind; detail: string }
  | { type: 'llm.provider'; provider: Provider };
