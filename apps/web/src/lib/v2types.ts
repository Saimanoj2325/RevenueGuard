// Shapes from docs/CONTRACT_V2.md (business layer). Money is integer rupees.

export type ProofKind = 'email' | 'whatsapp' | 'photo' | 'voice' | 'sheet' | 'zoho' | 'pdf' | 'bank' | 'manual';
export interface Proof { kind: ProofKind; label: string; node_id?: string | null }

export type BillStatus = 'not_billed' | 'partial' | 'needs_check';
export interface ToBillRow {
  case_ref: string; customer_id: string; customer: string; po_ref: string; headline: string;
  status: BillStatus; waiting_days: number; amount: number; proofs: Proof[];
  approval_id?: string | null; // ext: open approval for this row (bulk approve)
  approvals_needed?: number; approvals_done?: number; // ext
}
export interface ChaseRow {
  invoice_number: string; customer_id: string; customer: string; amount: number; due_date: string; days_late: number;
  reminder: { stage: 0 | 7 | 15 | 30; status: 'none' | 'draft' | 'sent' | 'read' | 'replied' };
  snoozed_until: string | null;
  note?: string | null; // ext: "promised Friday"
  approval_id?: string | null; // ext: reminder draft waiting approval
}
export interface ApprovalCard {
  id: string; case_ref: string; customer: string; po_ref: string; what: string; amount: number; gst: number; total: number;
  approvers_needed: number; approvals: { user: string; at: string }[]; proofs: Proof[]; expires_reason: string | null;
  kind: 'invoice' | 'reminder';
  status?: string; created_at?: string; message?: string | null; // ext
}
export interface DashboardSummary {
  not_billed: { amount: number; count: number; oldest_days: number };
  overdue: { amount: number; count: number; reminders_sent: number };
  recovered: { amount: number; invoices: number; last_month: number };
  waiting: { amount: number; count: number };
  flow: { ordered: number; delivered: number; billed: number; paid: number };
  to_bill: ToBillRow[]; to_chase: ChaseRow[]; approvals: ApprovalCard[];
  leaks?: { customer_id: string; customer: string; not_billed: number; overdue: number }[]; // ext
}

export type JourneyKey = 'received' | 'read' | 'matched' | 'checked' | 'waiting' | 'invoiced' | 'verified' | 'paid';
export type StepStatus = 'done' | 'current' | 'waiting' | 'problem' | 'todo';
export interface JourneyStep { key: JourneyKey; status: StepStatus; at: string | null; caption: string | null }
export interface Journey { current: JourneyKey; problem: null | { reason: string; next: string }; steps: JourneyStep[] }
export interface CaseDoc { stage: 'order' | 'delivery' | 'invoice' | 'payment'; status: 'found' | 'partial' | 'conflict' | 'missing'; date: string | null; source: string | null; key_number: string | null }
export interface Fact { id: string; label: string; value: string; source: Proof; changed_from: string | null; at: string | null; highlight?: string[] }
export interface GstLine { item: string; hsn: string; qty: number; rate: number; taxable: number }
export interface GstPreview {
  seller_gstin: string; buyer_gstin: string; place_of_supply: string; lines: GstLine[];
  cgst: number; sgst: number; igst: number; round_off: number; total: number; total_words: string; irn_note: string | null;
}
export interface CaseSummaryV2 {
  case_ref: string; po_ref: string; customer: string; customer_id: string; headline: string; recommendation: string;
  confidence: 'high' | 'needs_check'; confidence_reason: string; journey: Journey; documents: CaseDoc[]; facts: Fact[];
  callouts: { kind: 'approval_expired' | 'quarantined' | 'corrected'; text: string }[];
  invoice_preview: GstPreview | null; approval: ApprovalCard | null;
  how_found: { agents: number; checks: number; seconds: number; extra_searches: string[] };
  state?: string; status_label?: string; waiting_days?: number; // ext
  // CONTRACT_V3 §4 (all optional: older API builds do not send them)
  timeline?: TimelineEvent[] | null;
  timeline_decision?: TimelineDecisionSummary | null;
  chat_memory?: ChatMemory | null;
}

// ---------------- CONTRACT_V3 §4: agentic timeline ----------------
export type TimelineStatus = 'active' | 'edited' | 'deleted' | 'duplicate' | 'superseded';
/** role from the Timeline agent: counts | replaced | duplicate_of:<node_id> | ignored */
export type TimelineRole = string;
export interface TimelineEvent {
  node_id: string; at?: string | null; kind?: string | null; source_label?: string | null; text?: string | null;
  status?: TimelineStatus | string | null; versions?: { text: string; at?: string | null }[] | null; duplicate_of?: string | null;
  read_by?: string | null; language?: string | null; challan_number?: string | null; qty?: number | null;
  role?: TimelineRole | null; why?: string | null;
}
export interface TimelineDecisionSummary {
  meaning?: string | null; delivered_total?: number | null; explanation_for_owner?: string | null;
  confidence?: number | null; verified?: boolean | null; failed_checks?: string[] | null;
}
export interface ChatMemoryCase { case_ref?: string | null; po_ref?: string | null; customer?: string | null; label?: string | null; status?: string | null }
export interface ChatMemory {
  chat_key?: string | null; label?: string | null; active_po?: string | null;
  open_questions?: string[] | string | null; pending?: string[] | string | null; summary?: string | null;
  cases?: (ChatMemoryCase | string)[] | null;
}

export type Risk = 'good' | 'watch' | 'high';
export interface CustomerRow {
  id: string; name: string; gstin: string; city: string; outstanding: number; overdue: number;
  avg_days_to_pay: number; terms_days: number; risk: Risk; risk_reason: string;
  not_billed?: number; // ext
}
export interface CustomerDetail {
  customer: CustomerRow & { contact_masked: string; contact_name?: string; since?: string };
  stats: { not_billed: number; overdue: number; avg_days_to_pay: number; terms_days: number; risk: Risk; risk_reason: string; not_billed_note?: string; overdue_note?: string };
  orders: { po_ref: string; case_ref: string | null; item?: string; date?: string; ordered: number; delivered: number; billed: number; paid: number; amount: number; status?: string }[];
  followups: { at: string; kind: string; text: string; status: string; draft?: string | null; approval_id?: string | null }[];
}
export interface UnlinkedItem {
  id: string; source: Proof; received_at: string; from: string; preview: string;
  extracted: { po_ref?: string; customer?: string; qty?: number };
  suggestions: { case_ref: string; po_ref: string; customer: string; confidence: number }[];
}
export interface SortedItem { at: string; text: string; outcome: string } // ext: "Sorted recently"
export interface ReportsSummary {
  recovered_by_month: { month: string; amount: number }[];
  unbilled_ageing: Record<'0-7' | '8-30' | '31-60' | '60+', number>;
  collections: { billed: number; collected: number; rate: number };
  receivables_ageing?: Record<string, number>; // ext
  billed_count?: number; gst_total?: number; payments?: number; caught?: number; caught_count?: number; still_open?: number; // ext
}
export interface Settings {
  company: { name: string; gstin: string; state_code: string; upi_vpa: string };
  digest: { enabled: boolean; time: string; channels: ('whatsapp' | 'email')[] };
  receipts_enabled: boolean; reminder_ladder: number[]; gst_default_rate: number; einvoice_turnover_threshold: number;
  language: 'en' | 'hi' | 'te';
  bill_partial?: boolean; irn_warning?: boolean; alert_above?: number; weekly_email?: boolean; approvals_on_whatsapp?: boolean; // ext
  notifications?: { approvals: boolean; digest: boolean; receipts: boolean; problems: boolean; quiet_hours: { from: string; to: string } };
}
export interface TeamMember { id: string; name: string; email: string; role: string; phone_masked: string | null; can?: string }
export interface ConnectorV2 {
  name: string; status: string; account?: string | null; detail?: string | null; last_sync?: string | null;
  health?: 'ok' | 'slow' | 'down' | 'relogin'; error_plain?: string | null; config?: Record<string, unknown>;
}
export type WaChatKind = 'person' | 'group' | 'community' | 'announcement' | 'channel' | 'broadcast';
export interface WaChat {
  jid: string; name: string | null; is_group: boolean; last_message_at: string | null; watched: boolean; note?: string; members?: number;
  /** person | group | community | announcement (a community's announcement group) | channel | broadcast; older APIs omit it */
  kind?: WaChatKind;
  /** phone digits for 1:1 chats (resolved from LID when WhatsApp hides it) */
  phone?: string | null;
  /** WhatsApp profile name when it differs from the saved contact name */
  push_name?: string;
  parent?: string; parent_name?: string;
}
export interface SheetColumn { header: string; meaning: string; confidence: 'sure' | 'check'; sample: string }
export interface Backfill { sources: { name: string; done: number; total: number; status: string; label?: string }[]; first_case_ref: string | null; found_amount?: number; found_count?: number }
export interface AskAnswer { answer: string; table: { columns: string[]; rows: (string | number)[][] } | null; proofs: Proof[]; actions: { label: string; href: string }[]; note?: string }

export interface AiModelHealth {
  name: 'nim' | 'groq' | 'ollama' | 'laya' | 'sarvam' | string;
  label: string; role: string; model: string;
  status: 'working' | 'slow' | 'down' | 'not_set_up' | 'demo';
  latency_ms: number | null; detail: string | null; error: string | null; checked_at: string;
}
export interface AiHealth { models: AiModelHealth[]; reader: string | null; summary: string; checked_at: string; demo_mode: boolean }
