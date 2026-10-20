// UX v2 business layer for the in-browser mock backend (docs/CONTRACT_V2.md).
// Every list/summary is DERIVED from the same mock DB the case engine uses, so approving in demo
// really moves the counters, creates the invoice and verifies it.
import { ApiError } from '../api';
import { buildJourney } from '../journey';
import { rupeesInWords } from '../format';
import type { Approval, CaseDetail, EvidenceNode, Proposal, User } from '../types';
import type {
  ApprovalCard, AskAnswer, CaseSummaryV2, ChaseRow, CustomerDetail, CustomerRow, DashboardSummary, Fact, GstPreview, Proof,
  ProofKind, Risk, Settings, SortedItem, TeamMember, TimelineEvent, ToBillRow, UnlinkedItem, WaChat,
} from '../v2types';
import { CUSTOMER_ID, MAIN_CASE, SECOND_CASE, USERS } from './fixtures';

const DAY = 86400e3;
const SELLER_GSTIN = '36AAACD7788K1Z2';
const SELLER_STATE = '36';
const NO = Symbol('no-route');
/** Demo case for the CONTRACT_V3 Timeline agent story (PO-207). */
export const TIMELINE_CASE = 'RG-1051';
export { NO };

// ---------------- state ----------------
export interface Cust { id: string; name: string; city: string; gstin: string; state_code: string; terms_days: number; avg_days: number; contact_name: string; phone: string; since: string; ignored_reminders: number; risk_note?: string }
export interface Order {
  po_ref: string; customer_id: string; case_ref: string | null; item: string; hsn: string; rate: number; ordered: number;
  delivered: number; billed: number; paid: number; days_ago: number; waiting_days: number;
  status?: 'not_billed' | 'partial' | 'needs_check'; proofs: Proof[]; headline?: string; invoice?: string | null;
  not_billable?: { reason: string; note: string; at: string } | null;
}
export interface Inv {
  number: string; customer_id: string; po_ref: string; amount: number; issued_days_ago: number; due_days_ago: number; paid: boolean;
  reminder: { stage: 0 | 7 | 15 | 30; status: 'none' | 'draft' | 'sent' | 'read' | 'replied' }; snoozed_until: string | null; note: string | null;
  followups: { days_ago: number; kind: string; text: string; status: string }[]; case_ref?: string | null; issued_at?: string; created_now?: boolean;
}
export interface Biz {
  customers: Cust[]; orders: Order[]; invoices: Inv[]; unlinked: UnlinkedItem[]; sorted: SortedItem[];
  aliases: { kind: 'customer' | 'po'; alias: string; canonical: string }[]; chats: WaChat[]; settings: Settings; team: TeamMember[];
  recovered: { base: number; invoices: number; last_month: number; extra: number; extra_count: number };
  backfillStart: number | null; reminderCase: Record<string, string>; invSeq: number; seededAt: number;
}

// ---------------- seed ----------------
const P = (kind: ProofKind, label: string, node_id?: string): Proof => ({ kind, label, node_id: node_id ?? null });

export function seedBiz(): Biz {
  const now = Date.now();
  const iso = (daysAgo: number, h = 0) => new Date(now - daysAgo * DAY + h * 3600e3).toISOString();
  const customers: Cust[] = [
    { id: 'c_srilakshmi', name: 'Sri Lakshmi Traders', city: 'Hyderabad', gstin: '36AAFCS4471K1Z9', state_code: '36', terms_days: 30, avg_days: 28, contact_name: 'Srinivas', phone: '9849011142', since: '2023', ignored_reminders: 0 },
    { id: 'c_venkat', name: 'Venkat Steel Works', city: 'Secunderabad', gstin: '36AAGFV2210M1Z4', state_code: '36', terms_days: 30, avg_days: 36, contact_name: 'Venkat', phone: '9000312277', since: '2022', ignored_reminders: 0 },
    { id: CUSTOMER_ID, name: 'Example Customer Pvt Ltd', city: 'Hyderabad', gstin: '36AABCE1234F1Z5', state_code: '36', terms_days: 30, avg_days: 41, contact_name: 'Ramesh', phone: '9866045210', since: '2024', ignored_reminders: 1, risk_note: 'slower than it was in July' },
    { id: 'c_kaveri', name: 'Kaveri Agro Foods', city: 'Warangal', gstin: '36AAKCK5530Q1Z1', state_code: '36', terms_days: 30, avg_days: 24, contact_name: 'Lakshmi', phone: '9440099812', since: '2023', ignored_reminders: 0 },
    { id: 'c_godavari', name: 'Godavari Plastics', city: 'Rajahmundry', gstin: '37AAHFG8812L1Z7', state_code: '37', terms_days: 30, avg_days: 52, contact_name: 'Prasad', phone: '9989077118', since: '2024', ignored_reminders: 3 },
    { id: 'c_deccan', name: 'Deccan Packaging LLP', city: 'Hyderabad', gstin: '36AAQFD6603P1Z3', state_code: '36', terms_days: 30, avg_days: 19, contact_name: 'Imtiaz', phone: '9701122334', since: '2021', ignored_reminders: 0 },
    { id: 'c_nizam', name: 'Nizam Electricals', city: 'Hyderabad', gstin: '36AABFN7741R1Z8', state_code: '36', terms_days: 30, avg_days: 30, contact_name: 'Farhan', phone: '9391155660', since: '2022', ignored_reminders: 0 },
    { id: 'c_sharma', name: 'Sharma Polymers', city: 'Bengaluru', gstin: '29AAPFS3390H1Z6', state_code: '29', terms_days: 45, avg_days: 47, contact_name: 'Anil', phone: '9845033221', since: '2023', ignored_reminders: 0 },
  ];
  const orders: Order[] = [
    // live story orders: delivered/billed come from the case engine (RG-1042, RG-1044)
    { po_ref: 'PO-184', customer_id: CUSTOMER_ID, case_ref: MAIN_CASE, item: 'Model X', hsn: '8481', rate: 1000, ordered: 100, delivered: 0, billed: 0, paid: 0, days_ago: 13, waiting_days: 3, proofs: [P('photo', 'Challan photo', 'ev_wa_challan'), P('voice', 'Voice note', 'ev_wa_voice'), P('email', 'PO email', 'ev_gm_order')] },
    { po_ref: 'PO-185', customer_id: CUSTOMER_ID, case_ref: SECOND_CASE, item: 'Model X', hsn: '8481', rate: 1000, ordered: 200, delivered: 0, billed: 0, paid: 0, days_ago: 2, waiting_days: 2, proofs: [P('email', 'PO email', 'ev185_order'), P('sheet', 'Sheet row 3', 'ev185_sheet')] },
    // other open deliveries (each has its own case with an approval request)
    { po_ref: 'PO-201', customer_id: 'c_srilakshmi', case_ref: 'RG-1046', item: 'Model X', hsn: '8481', rate: 1000, ordered: 200, delivered: 148, billed: 0, paid: 0, days_ago: 8, waiting_days: 6, headline: 'Delivered 148 of 200 Model X. No invoice in Zoho.', proofs: [P('photo', 'Challan DC-5530', 'n46_photo'), P('sheet', 'Sheet row 61', 'n46_sheet'), P('whatsapp', 'PO on WhatsApp', 'n46_po')] },
    { po_ref: 'PO-198', customer_id: 'c_venkat', case_ref: 'RG-1045', item: 'Model Z', hsn: '8481', rate: 1000, ordered: 120, delivered: 109, billed: 0, paid: 0, days_ago: 9, waiting_days: 5, status: 'partial', headline: '109 of 120 delivered. Bill what reached them.', proofs: [P('sheet', 'Sheet row 58', 'n45_sheet'), P('email', 'PO email', 'n45_po')] },
    { po_ref: 'PO-195', customer_id: 'c_deccan', case_ref: 'RG-1049', item: 'Carton 5-ply', hsn: '4819', rate: 800, ordered: 120, delivered: 120, billed: 0, paid: 0, days_ago: 15, waiting_days: 11, headline: 'All 120 cartons delivered 11 days ago. Never billed.', proofs: [P('email', 'PO email', 'n49_po'), P('pdf', 'Signed challan PDF', 'n49_pdf')] },
    { po_ref: 'PO-176', customer_id: 'c_kaveri', case_ref: 'RG-1047', item: 'Model Y', hsn: '8481', rate: 500, ordered: 100, delivered: 75, billed: 40, paid: 0, days_ago: 12, waiting_days: 4, headline: 'Delivered 75, billed only 40.', proofs: [P('photo', 'Challan photo', 'n47_photo'), P('zoho', 'INV-2198', 'n47_inv')] },
    { po_ref: 'PO-188', customer_id: 'c_godavari', case_ref: 'RG-1048', item: 'Model Y', hsn: '8481', rate: 500, ordered: 50, delivered: 50, billed: 0, paid: 0, days_ago: 10, waiting_days: 2, status: 'needs_check', headline: 'Voice note says 50, sheet says 45. Please check the count.', proofs: [P('voice', 'Voice note', 'n48_voice'), P('sheet', 'Sheet row 52', 'n48_sheet')] },
    // CONTRACT_V3 demo: two challans 60 + 40 = 100, a resent photo, an edited and a deleted message, a Hindi voice note read by Sarvam
    { po_ref: 'PO-207', customer_id: 'c_nizam', case_ref: TIMELINE_CASE, item: 'Model X', hsn: '8481', rate: 1000, ordered: 100, delivered: 100, billed: 0, paid: 0, days_ago: 3, waiting_days: 1, headline: 'All 100 Model X delivered in two challans (60 + 40). No invoice in Zoho.', proofs: [P('photo', 'Challan DC-6101', 'n51_ch1'), P('photo', 'Challan DC-6102', 'n51_ch2'), P('voice', 'Voice note (Hindi)', 'n51_voice')] },
    { po_ref: 'PO-196', customer_id: 'c_godavari', case_ref: 'RG-1050', item: 'Model Y', hsn: '8481', rate: 500, ordered: 60, delivered: 0, billed: 0, paid: 0, days_ago: 4, waiting_days: 0, headline: 'Ordered 60. Waiting for delivery proof.', proofs: [P('email', 'PO email', 'n50_po')] },
    // history (billed / paid)
    { po_ref: 'PO-170', customer_id: CUSTOMER_ID, case_ref: null, item: 'Model X', hsn: '8481', rate: 1000, ordered: 50, delivered: 50, billed: 50, paid: 50, days_ago: 43, waiting_days: 0, proofs: [], invoice: 'INV-2201' },
    { po_ref: 'PO-162', customer_id: CUSTOMER_ID, case_ref: null, item: 'Model Y', hsn: '8481', rate: 1000, ordered: 85, delivered: 85, billed: 85, paid: 0, days_ago: 58, waiting_days: 0, proofs: [], invoice: 'INV-2190' },
    { po_ref: 'PO-151', customer_id: CUSTOMER_ID, case_ref: null, item: 'Model X', hsn: '8481', rate: 1000, ordered: 120, delivered: 120, billed: 120, paid: 120, days_ago: 77, waiting_days: 0, proofs: [], invoice: 'INV-2160A' },
    { po_ref: 'PO-190', customer_id: 'c_srilakshmi', case_ref: null, item: 'Model X', hsn: '8481', rate: 1000, ordered: 148, delivered: 148, billed: 148, paid: 110, days_ago: 14, waiting_days: 0, proofs: [], invoice: 'INV-2215' },
    { po_ref: 'PO-186', customer_id: 'c_venkat', case_ref: null, item: 'Model Z', hsn: '8481', rate: 1000, ordered: 136, delivered: 136, billed: 136, paid: 73.5, days_ago: 12, waiting_days: 0, proofs: [], invoice: 'INV-2177' },
    { po_ref: 'PO-181', customer_id: 'c_kaveri', case_ref: null, item: 'Model Y', hsn: '8481', rate: 500, ordered: 249, delivered: 249, billed: 249, paid: 218, days_ago: 13, waiting_days: 0, proofs: [], invoice: 'INV-2229' },
    { po_ref: 'PO-158', customer_id: 'c_godavari', case_ref: null, item: 'Model Y', hsn: '8481', rate: 500, ordered: 29, delivered: 29, billed: 29, paid: 0, days_ago: 61, waiting_days: 0, proofs: [], invoice: 'INV-2160' },
    { po_ref: 'PO-183', customer_id: 'c_nizam', case_ref: null, item: 'Model X', hsn: '8481', rate: 1000, ordered: 54, delivered: 54, billed: 54, paid: 54, days_ago: 11, waiting_days: 0, proofs: [], invoice: 'INV-2220' },
    { po_ref: 'PO-187', customer_id: 'c_deccan', case_ref: null, item: 'Carton 5-ply', hsn: '4819', rate: 800, ordered: 140, delivered: 0, billed: 0, paid: 0, days_ago: 6, waiting_days: 0, proofs: [] },
    { po_ref: 'PO-189', customer_id: 'c_sharma', case_ref: null, item: 'Granules', hsn: '3901', rate: 250, ordered: 400, delivered: 400, billed: 400, paid: 0, days_ago: 9, waiting_days: 0, proofs: [], invoice: 'INV-2224' },
    { po_ref: 'PO-161', customer_id: 'c_sharma', case_ref: null, item: 'Granules', hsn: '3901', rate: 250, ordered: 194, delivered: 194, billed: 194, paid: 194, days_ago: 40, waiting_days: 0, proofs: [], invoice: 'INV-2179' },
  ];
  const inv = (number: string, customer_id: string, po_ref: string, amount: number, issued: number, due: number, stage: Inv['reminder']['stage'], status: Inv['reminder']['status'], note: string | null, followups: Inv['followups'] = []): Inv =>
    ({ number, customer_id, po_ref, amount, issued_days_ago: issued, due_days_ago: due, paid: false, reminder: { stage, status }, snoozed_until: null, note, followups });
  const invoices: Inv[] = [
    inv('INV-2190', CUSTOMER_ID, 'PO-162', 85000, 71, 41, 30, 'draft', 'reminder 3 ready', [
      { days_ago: 7, kind: 'Reminder 1 · WhatsApp · UPI link', text: 'Read · no reply', status: 'read' },
      { days_ago: 0, kind: 'Reminder 2 · WhatsApp + email', text: 'Read 10:14 AM · Ramesh: "will check with accounts"', status: 'replied' },
    ]),
    inv('INV-2177', 'c_venkat', 'PO-186', 62500, 52, 22, 15, 'replied', 'promised Friday', [
      { days_ago: 7, kind: 'Reminder 1 · WhatsApp', text: 'Read', status: 'read' },
      { days_ago: 1, kind: 'Reminder 2 · WhatsApp', text: 'Venkat: "payment on Friday"', status: 'replied' },
    ]),
    inv('INV-2160', 'c_godavari', 'PO-158', 14500, 61, 31, 30, 'sent', 'no reply to 3', [
      { days_ago: 24, kind: 'Reminder 1 · WhatsApp', text: 'Delivered · no reply', status: 'sent' },
      { days_ago: 16, kind: 'Reminder 2 · WhatsApp', text: 'Delivered · no reply', status: 'sent' },
      { days_ago: 1, kind: 'Reminder 3 · firm', text: 'Delivered · no reply', status: 'sent' },
    ]),
    inv('INV-2215', 'c_srilakshmi', 'PO-190', 38000, 39, 9, 7, 'sent', 'reminder 1 sent', [{ days_ago: 2, kind: 'Reminder 1 · WhatsApp · UPI link', text: 'Delivered', status: 'sent' }]),
    inv('INV-2205', 'c_kaveri', 'PO-181', 15500, 34, 4, 0, 'none', null),
    inv('INV-2224', 'c_sharma', 'PO-189', 118000, 9, -36, 0, 'none', null),
  ];
  const unlinked: UnlinkedItem[] = [
    {
      id: 'ul_1', source: P('photo', 'Challan photo'), received_at: iso(0, -0.5), from: '+91 90••• ••118 (not in your contacts)',
      preview: 'Photo of a delivery challan. PO number is blurred. Readable: "Model X · 40 nos · Sri Lakshmi".',
      extracted: { customer: 'Sri Lakshmi', qty: 40 }, suggestions: [{ case_ref: 'RG-1046', po_ref: 'PO-201', customer: 'Sri Lakshmi Traders', confidence: 0.82 }],
    },
    {
      id: 'ul_2', source: P('voice', 'Voice note'), received_at: iso(0, -3), from: 'Ravi (dispatch)',
      preview: 'Voice note, Telugu: "Godavari ki 25 boxes pampinchamu" (sent 25 boxes to Godavari).',
      extracted: { customer: 'Godavari', qty: 25 }, suggestions: [
        { case_ref: 'RG-1048', po_ref: 'PO-188', customer: 'Godavari Plastics', confidence: 0.46 },
        { case_ref: 'RG-1050', po_ref: 'PO-196', customer: 'Godavari Plastics', confidence: 0.44 },
      ],
    },
  ];
  const sorted: SortedItem[] = [
    { at: iso(1), text: 'Photo from Imran → PO-198', outcome: "attached by Priya · we'll remember Imran's number is dispatch" },
    { at: iso(2), text: 'Email "Good morning" from a supplier', outcome: 'ignored · not about an order' },
  ];
  const chats: WaChat[] = [
    { jid: '120363001@g.us', name: 'Dispatch Team', is_group: true, members: 8, last_message_at: iso(0, -0.04), watched: true, note: 'Challans, delivery updates' },
    { jid: '919000000111@s.whatsapp.net', name: 'Ravi (dispatch)', is_group: false, last_message_at: iso(0, -0.07), watched: true, note: 'Voice notes, photos' },
    { jid: '919000000222@s.whatsapp.net', name: 'Imran (driver)', is_group: false, last_message_at: iso(1), watched: true, note: 'Delivery photos' },
    { jid: '919866045210@s.whatsapp.net', name: 'Example Customer – Ramesh', is_group: false, last_message_at: iso(0, -5), watched: true, note: 'Payment replies' },
    { jid: '120363002@g.us', name: 'Sri Lakshmi Orders', is_group: true, members: 5, last_message_at: iso(1, -2), watched: true, note: 'POs on WhatsApp' },
    { jid: '919000000333@s.whatsapp.net', name: 'Accounts – Priya', is_group: false, last_message_at: iso(2), watched: true, note: '' },
    { jid: '120363003@g.us', name: 'Family', is_group: true, members: 9, last_message_at: iso(0, -0.02), watched: false, note: '' },
    { jid: '120363004@g.us', name: 'College friends', is_group: true, members: 31, last_message_at: iso(0, -0.17), watched: false, note: '' },
    { jid: '919876543204@s.whatsapp.net', name: null, is_group: false, kind: 'person', phone: '919876543204', push_name: 'Suresh', last_message_at: iso(0, -0.5), watched: false, note: '' },
    { jid: '81234567890123@lid', name: null, is_group: false, kind: 'person', phone: null, last_message_at: iso(0, -0.6), watched: false, note: '' },
    { jid: '120363010@g.us', name: 'Hyderabad Traders Association', is_group: true, kind: 'community', members: 240, last_message_at: iso(1), watched: false, note: '' },
    { jid: '120363011@g.us', name: 'Hyderabad Traders Association', is_group: true, kind: 'announcement', parent: '120363010@g.us', parent_name: 'Hyderabad Traders Association', members: 240, last_message_at: iso(1), watched: false, note: '' },
    { jid: '120363012@g.us', name: 'Steel dealers', is_group: true, kind: 'group', parent: '120363010@g.us', parent_name: 'Hyderabad Traders Association', members: 46, last_message_at: iso(0, -3), watched: false, note: '' },
    { jid: '120363013@newsletter', name: 'GST Council Updates', is_group: false, kind: 'channel', last_message_at: iso(0, -8), watched: false, note: '' },
  ];
  const settings: Settings = {
    company: { name: 'Demo Manufacturing Pvt Ltd', gstin: SELLER_GSTIN, state_code: SELLER_STATE, upi_vpa: 'demomfg@icici' },
    digest: { enabled: true, time: '09:00', channels: ['whatsapp'] }, receipts_enabled: true, reminder_ladder: [7, 15, 30], gst_default_rate: 18,
    einvoice_turnover_threshold: 50000000, language: 'en', bill_partial: true, irn_warning: true, alert_above: 10000, weekly_email: false, approvals_on_whatsapp: true,
    notifications: { approvals: true, digest: true, receipts: true, problems: true, quiet_hours: { from: '22:00', to: '08:00' } },
  };
  const team: TeamMember[] = [
    { id: 'u_admin', name: 'Aditi Rao', email: 'admin@demo.in', role: 'admin', phone_masked: '+91 98••• ••101', can: 'Everything · approve any amount' },
    { id: 'u_ops', name: 'Ravi Kumar', email: 'ops@demo.in', role: 'operator', phone_masked: '+91 90••• ••222', can: 'Bill, collect, fix facts · cannot approve' },
    { id: 'u_fin', name: 'Meera Iyer', email: 'finance@demo.in', role: 'finance_approver', phone_masked: '+91 99••• ••310', can: 'Approve invoices and reminders' },
    { id: 'u_fin2', name: 'Arjun Shah', email: 'finance2@demo.in', role: 'finance_approver', phone_masked: '+91 97••• ••455', can: 'Second approver above ₹1 lakh' },
    { id: 'u_ca', name: 'CA Srinivas', email: 'ca@srinivasassociates.in', role: 'viewer', phone_masked: null, can: 'Reports and exports · no approvals' },
  ];
  return {
    customers, orders, invoices, unlinked, sorted, aliases: [{ kind: 'customer', alias: 'Exmpl Cust', canonical: 'Example Customer Pvt Ltd' }, { kind: 'po', alias: '184', canonical: 'PO-184' }],
    chats, settings, team, recovered: { base: 340000, invoices: 5, last_month: 185000, extra: 0, extra_count: 0 }, backfillStart: null, reminderCase: {}, invSeq: 2232, seededAt: now,
  };
}

/** Background cases for the extra open deliveries: evidence + validator facts + a pending approval each. */
export function seedOrderCases(mb: any) {
  const biz: Biz = mb.db.biz;
  const ts = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
  const mk = (o: Order, nodes: EvidenceNode[], state: string, withApproval: boolean) => {
    const c = biz.customers.find((x) => x.id === o.customer_id)!;
    const id = o.case_ref!;
    const d: CaseDetail = {
      case: { id, state: state as any, customer: c.name, customer_id: c.id, reference: o.po_ref, amount: o.ordered * o.rate, exception_type: o.status === 'needs_check' ? 'quantity_conflict' : 'missing_invoice', severity: 'high', correlation_id: `c0ffee${id.slice(3)}-0000-4a0b-9d2c-${id.slice(3)}ab12e7f0`, evidence_version: nodes.length, created_at: ts(o.waiting_days * 24 + 6), updated_at: ts(o.waiting_days * 24), summary: o.headline ?? null },
      timeline: [
        { stage: 'order', status: 'found', evidence_node_ids: nodes.filter((n) => n.kind === 'email' || n.kind === 'message').map((n) => n.id) },
        { stage: 'delivery', status: o.delivered === 0 ? 'missing' : o.status === 'needs_check' ? 'conflict' : o.delivered < o.ordered ? 'partial' : 'found', evidence_node_ids: nodes.filter((n) => n.kind !== 'email').map((n) => n.id) },
        { stage: 'invoice', status: 'missing', evidence_node_ids: [] },
        { stage: 'payment', status: 'missing', evidence_node_ids: [] },
      ],
      evidence: { nodes, edges: nodes.slice(1).map((n) => ({ from: nodes[0].id, to: n.id, label: o.po_ref })) },
      agent_runs: [], checkpoints: [{ seq: 1, state: 'INTAKE', evidence_version: 1, ts: ts(o.waiting_days * 24 + 6) }, { seq: 2, state: state as any, evidence_version: nodes.length, ts: ts(o.waiting_days * 24) }],
      proposal: null, approvals: [], actions: [], verification: null, laya: null,
      facts: o.delivered ? { ref_normalized: o.po_ref.replace('-', ''), order_qty: o.ordered, delivered_qty: o.delivered, rate: o.rate, rule: 'bill_delivered_qty', billable_qty: o.delivered, billable_amount: o.delivered * o.rate, duplicates: [], evidence_version: nodes.length, check: { amount_matches: true, claims_cited: true, errors: [] } } : null,
    };
    mb.db.cases[id] = d;
    mb.db.trace[id] = [];
    if (withApproval) {
      const p = orderProposal(o, c.name, 1, o.delivered - o.billed);
      d.proposal = p;
      const a: Approval = mb.createApproval(id, p, true);
      a.created_at = ts(o.waiting_days * 24 - 1);
    }
  };
  const n = (id: string, source: any, kind: string, title: string, excerpt: string, fields: any, h: number, extra: Partial<EvidenceNode> = {}): EvidenceNode => ({ id, source, kind, title, excerpt, fields, source_id: `${source}:${id}`, ts: ts(h), ...extra });
  const O = (po: string) => biz.orders.find((o) => o.po_ref === po)!;
  mk(O('PO-201'), [
    n('n46_po', 'whatsapp', 'message', 'PO-201 on WhatsApp (Sri Lakshmi Orders)', 'Please send 200 Model X against PO-201 @ ₹1,000.', { po: 'PO-201', qty: 200, rate: 1000 }, 200),
    n('n46_photo', 'media', 'photo', 'Challan DC-5530 (photo)', 'Read: PO-201 · Model X · 148 boxes', { po: 'PO-201', qty: 148, challan: 'DC-5530' }, 150),
    n('n46_sheet', 'sheets', 'sheet_row', 'Dispatch sheet row 61', 'PO-201 · delivered 148 · pending 52', { po: 'PO-201', delivered: 148, pending: 52 }, 148),
  ], 'AWAITING_APPROVAL', true);
  mk(O('PO-198'), [
    n('n45_po', 'gmail', 'email', 'PO-198 from Venkat Steel Works', '120 × Model Z at ₹1,000', { po: 'PO-198', qty: 120, rate: 1000 }, 220),
    n('n45_sheet', 'sheets', 'sheet_row', 'Dispatch sheet row 58', 'PO-198 · delivered 109 · pending 11', { po: 'PO-198', delivered: 109, pending: 11 }, 125),
  ], 'AWAITING_APPROVAL', true);
  mk(O('PO-195'), [
    n('n49_po', 'gmail', 'email', 'PO-195 from Deccan Packaging', '120 × Carton 5-ply at ₹800', { po: 'PO-195', qty: 120, rate: 800 }, 360),
    n('n49_pdf', 'drive', 'document', 'Signed challan DC-5490 (PDF)', 'Received 120 cartons · signed by Imtiaz', { po: 'PO-195', qty: 120, challan: 'DC-5490' }, 264),
  ], 'AWAITING_APPROVAL', true);
  mk(O('PO-176'), [
    n('n47_po', 'gmail', 'email', 'PO-176 from Kaveri Agro Foods', '100 × Model Y at ₹500', { po: 'PO-176', qty: 100, rate: 500 }, 290),
    n('n47_photo', 'media', 'photo', 'Challan DC-5502 (photo)', 'Read: PO-176 · Model Y · 75', { po: 'PO-176', qty: 75, challan: 'DC-5502' }, 170),
    n('n47_inv', 'zoho', 'invoice', 'INV-2198 in Zoho', 'PO-176 · 40 × Model Y · ₹20,000 + GST', { invoice: 'INV-2198', qty: 40 }, 160),
  ], 'AWAITING_APPROVAL', true);
  mk(O('PO-188'), [
    n('n48_po', 'gmail', 'email', 'PO-188 from Godavari Plastics', '50 × Model Y at ₹500', { po: 'PO-188', qty: 50, rate: 500 }, 240),
    n('n48_voice', 'media', 'voice_note', 'Voice note from Ravi (dispatch)', 'Transcript: "Godavari PO-188 50 boxes delivered"', { po: 'PO-188', qty: 50 }, 218, { derived_text: 'Godavari PO-188 50 boxes delivered' }),
    n('n48_sheet', 'sheets', 'sheet_row', 'Dispatch sheet row 52', 'PO-188 · delivered 45 · pending 5', { po: 'PO-188', delivered: 45, pending: 5 }, 46),
  ], 'ESCALATED', false);
  mk(O('PO-196'), [
    n('n50_po', 'gmail', 'email', 'PO-196 from Godavari Plastics', '60 × Model Y at ₹500', { po: 'PO-196', qty: 60, rate: 500 }, 96),
  ], 'WATCHING', false);
  mk(O('PO-207'), [
    n('n51_po', 'gmail', 'email', 'PO-207 from Nizam Electricals', '100 × Model X at ₹1,000', { po: 'PO-207', qty: 100, rate: 1000 }, 74),
    n('n51_ch1', 'media', 'photo', 'Challan DC-6101 (photo)', 'Read: PO-207 · Model X · 60 nos · DC-6101', { po: 'PO-207', qty: 60, challan: 'DC-6101' }, 50),
    n('n51_ch2', 'media', 'photo', 'Challan DC-6102 (photo)', 'Read: PO-207 · Model X · 40 nos · DC-6102', { po: 'PO-207', qty: 40, challan: 'DC-6102' }, 27),
    n('n51_voice', 'media', 'voice_note', 'Voice note from Ravi (dispatch)', 'Transcript: "PO-207 ka baaki 40 box Nizam ko pahuncha diya"', { po: 'PO-207', qty: 40 }, 26.5, { derived_text: 'PO-207 ka baaki 40 box Nizam ko pahuncha diya (sent the remaining 40 boxes to Nizam)' }),
  ], 'AWAITING_APPROVAL', true);
  seedTimelineStory(mb, TIMELINE_CASE, ts);
  // payment reminder waiting for approval (INV-2190, 41 days late)
  draftReminder(mb, 'INV-2190', 30, true);
}

/** CONTRACT_V3 §4 demo data: timeline, the Timeline agent's decision, chat memory and the agent's tool steps. */
export function seedTimelineStory(mb: any, id: string, ts: (h: number) => string) {
  const d: any = mb.db.cases[id];
  if (!d) return;
  const timeline: TimelineEvent[] = [
    { node_id: 'n51_po', at: ts(74), kind: 'email', source_label: 'Email · Farhan (Nizam Electricals)', text: 'PO-207: please send 100 Model X at ₹1,000.', status: 'active', qty: null, role: 'ignored', why: 'This is the order, not a delivery.' },
    { node_id: 'n51_ch1', at: ts(50), kind: 'photo', source_label: 'Photo · Dispatch Team', text: 'Challan DC-6101 · PO-207 · Model X · 60 nos', status: 'active', challan_number: 'DC-6101', qty: 60, role: 'counts', why: 'First challan for PO-207. 60 boxes written on it.' },
    { node_id: 'n51_msg', at: ts(49.8), kind: 'message', source_label: 'WhatsApp · Ravi (dispatch)', text: 'PO-207 total 100 delivered to Nizam', status: 'edited', versions: [{ text: 'PO-207 60 delivered to Nizam', at: ts(49.8) }], qty: 100, role: 'ignored', why: 'Ravi changed 60 to 100 after the second trip. It is a running total, so we count the challans, not this line.' },
    { node_id: 'n51_ch1_again', at: ts(30), kind: 'photo', source_label: 'Photo · Dispatch Team', text: 'Challan DC-6101 · PO-207 · Model X · 60 nos', status: 'duplicate', duplicate_of: 'n51_ch1', challan_number: 'DC-6101', qty: 60, role: 'duplicate_of:n51_ch1', why: 'Same photo as DC-6101, sent again. Counting it would make 160.' },
    { node_id: 'n51_ch2', at: ts(27), kind: 'photo', source_label: 'Photo · Dispatch Team', text: 'Challan DC-6102 · PO-207 · Model X · 40 nos', status: 'active', challan_number: 'DC-6102', qty: 40, role: 'counts', why: 'Second challan, new number DC-6102. The remaining 40.' },
    { node_id: 'n51_del', at: ts(26.8), kind: 'message', source_label: 'WhatsApp · Imran (driver)', text: 'PO-207 50 boxes unloaded', status: 'deleted', qty: 50, role: 'ignored', why: 'Imran deleted this message himself. Kept for the record only.' },
    { node_id: 'n51_voice', at: ts(26.5), kind: 'voice', source_label: 'Voice note · Ravi (dispatch)', text: 'PO-207 ka baaki 40 box Nizam ko pahuncha diya (sent the remaining 40 boxes to Nizam)', status: 'active', read_by: 'sarvam', language: 'hi-IN', qty: 40, role: 'ignored', why: 'Confirms the same 40 as challan DC-6102. Not counted twice.' },
  ];
  d.v3 = {
    timeline,
    timeline_decision: { meaning: 'extra_delivery', delivered_total: 100, confidence: 0.93, verified: true, failed_checks: [], explanation_for_owner: 'Two challans for PO-207: DC-6101 (60) and DC-6102 (40), so 100 delivered. The resent photo, the deleted message and the edited total were not counted again.' },
    chat_memory: {
      chat_key: 'wa:120363001@g.us', label: 'Dispatch Team (WhatsApp group)', active_po: 'PO-207',
      summary: 'Ravi sends challan photos and Hindi voice notes. PO-207 for Nizam went in two trips (60 + 40). PO-201 for Sri Lakshmi is still 52 short.',
      open_questions: ['Is the last 52 for PO-201 going this week?'], pending: ['PO-201: 52 Model X not delivered yet'],
      cases: [{ case_ref: 'RG-1046', po_ref: 'PO-201', customer: 'Sri Lakshmi Traders', label: '148 of 200 delivered' }, { case_ref: id, po_ref: 'PO-207', customer: 'Nizam Electricals', label: '100 of 100 delivered' }],
    },
  };
  // Timeline agent steps for Agent activity (one run per lifecycle event)
  const ev: any[] = [];
  const run = (run_id: string, h: number, steps: { tool: string; args: any; why: string; result: string }[], output: any) => {
    let t = new Date(ts(h)).getTime();
    const at = () => new Date((t += 700)).toISOString();
    ev.push({ run_id, case_id: id, agent: 'timeline', type: 'run_started', data: {}, ts: at() });
    ev.push({ run_id, case_id: id, agent: 'timeline', type: 'model_call', data: { provider: 'nim', model: 'deepseek-v4.1-flash', tokens_in: 2600, tokens_out: 420, cost_inr: 0.27 }, ts: at() });
    steps.forEach((s, i) => {
      ev.push({ run_id, case_id: id, agent: 'timeline', type: 'tool_call', data: { step: i + 1, tool: s.tool, args: s.args, why: s.why }, ts: at() });
      ev.push({ run_id, case_id: id, agent: 'timeline', type: 'tool_result', data: { step: i + 1, tool: s.tool, ok: true, summary: s.result }, ts: at() });
    });
    ev.push({ run_id, case_id: id, agent: 'timeline', type: 'run_finished', data: { output, steps: steps.length }, ts: at() });
  };
  run('tl_run_resend', 30, [
    { tool: 'read_chat_memory', args: { chat_key: 'wa:120363001@g.us' }, why: 'Which PO is this chat talking about right now?', result: 'active_po PO-207; 1 open question about PO-201' },
    { tool: 'read_case_timeline', args: { case_ref: id }, why: 'See every message for PO-207 before deciding.', result: '4 nodes: order, DC-6101 (60), edited total, new photo (duplicate of n51_ch1)' },
    { tool: 'propose_timeline', args: { case_ref: id, meaning: 'duplicate', total: 60 }, why: 'Same challan number and same photo: do not count it again.', result: 'verifier passed: total 60 = 60' },
  ], { meaning: 'duplicate', delivered_total: 60 });
  run('tl_run_voice', 26.4, [
    { tool: 'read_chat_memory', args: { chat_key: 'wa:120363001@g.us' }, why: 'Link the voice note to the right PO.', result: 'active_po PO-207' },
    { tool: 'search_cases', args: { po_ref: 'PO-207' }, why: 'Make sure PO-207 exists and is still open.', result: 'RG-1051 · Nizam Electricals · ordered 100' },
    { tool: 'read_case_timeline', args: { case_ref: id }, why: 'Check which messages are deleted or repeated.', result: 'DC-6101 60 counts · DC-6102 40 counts · photo resent (duplicate) · Imran message deleted · voice note 40 (Sarvam, Hindi)' },
    { tool: 'whatsapp_search', args: { chat_key: 'wa:120363001@g.us', text: 'PO-207', since: '3d' }, why: 'Look for any other challan for PO-207.', result: 'No other challan numbers found' },
    { tool: 'sheets_read_delivery', args: { po_ref: 'PO-207' }, why: 'Cross-check with the dispatch sheet.', result: 'No sheet row for PO-207 yet' },
    { tool: 'propose_timeline', args: { case_ref: id, meaning: 'extra_delivery', total: 100, counts: ['n51_ch1', 'n51_ch2'] }, why: 'Two different challans, 60 + 40. Voice note repeats the 40.', result: 'verifier passed: nodes exist, qty grounded, 60 + 40 = 100, PO-207 exists, confidence 0.93' },
    { tool: 'write_chat_memory', args: { chat_key: 'wa:120363001@g.us', patch: { active_po: 'PO-207', pending: ['PO-201: 52 not delivered'] } }, why: 'Remember where this chat stands for the next message.', result: 'memory updated (312 chars)' },
  ], { meaning: 'extra_delivery', delivered_total: 100 });
  mb.db.trace[id] = ev;
}

export function orderProposal(o: { po_ref: string; customer_id: string; item: string; rate: number; ordered: number }, customerName: string, version: number, qty?: number): Proposal {
  const q = qty ?? (o as Order).delivered;
  return {
    id: `prop_${o.po_ref}_v${version}`, version, risk: 'low', created_at: new Date().toISOString(),
    action: { type: 'create_invoice', customer_id: o.customer_id, customer_name: customerName, reference: o.po_ref, line_items: [{ item: o.item, qty: q, rate: o.rate }], amount: q * o.rate },
    claims: [{ text: `${customerName} ordered ${o.ordered} × ${o.item} under ${o.po_ref}.`, evidence_node_ids: [] }, { text: `${q} delivered and not billed.`, evidence_node_ids: [] }],
    uncertainty: [], validation: { ok: true, errors: [] },
  };
}

// ---------------- derivations ----------------
const gstRate = (biz: Biz) => (biz.settings.gst_default_rate ?? 18) / 100;
const withGst = (biz: Biz, n: number) => Math.round(n * (1 + gstRate(biz)));
export function custOf(biz: Biz, id?: string | null) { return biz.customers.find((c) => c.id === id) ?? null; }
const userName = (email?: string) => USERS.find((u) => u.email === email)?.name?.split(' ')[0] ?? email?.split('@')[0] ?? 'Someone';

/** Live values for an order: case facts win over the fixture. */
export function liveOrder(mb: any, o: Order): Order & { open_approval: Approval | null; case_state: string | null } {
  const d: CaseDetail | undefined = o.case_ref ? mb.db.cases[o.case_ref] : undefined;
  let delivered = o.delivered, billed = o.billed, invoice = o.invoice ?? null;
  if (d) {
    const f = d.facts ?? null;
    if (o.case_ref === MAIN_CASE || o.case_ref === SECOND_CASE) delivered = f?.delivered_qty ?? 0;
    else if (f?.delivered_qty != null) delivered = f.delivered_qty;
    const act = d.actions.find((a) => a.type === 'create_invoice' && a.status === 'succeeded');
    if (act) { billed = d.proposal?.action.line_items[0]?.qty ?? delivered; invoice = act.target_id ?? invoice; }
  } else if (o.case_ref === MAIN_CASE || o.case_ref === SECOND_CASE) delivered = 0;
  const open_approval = o.case_ref ? (Object.values(mb.db.approvals) as Approval[]).filter((a) => a.case_id === o.case_ref && (a.status === 'pending' || a.status === 'partially_approved') && a.action_type !== 'send_reminder').sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0] ?? null : null;
  return { ...o, delivered, billed, invoice, open_approval, case_state: d?.case.state ?? null };
}

export function toBillRows(mb: any): ToBillRow[] {
  const biz: Biz = mb.db.biz;
  return biz.orders.map((o) => liveOrder(mb, o)).filter((o) => o.case_ref && !o.not_billable && o.delivered > o.billed).map((o) => {
    const c = custOf(biz, o.customer_id)!;
    const qty = o.delivered - o.billed;
    const d: CaseDetail | undefined = mb.db.cases[o.case_ref!];
    const conflict = d?.timeline.find((t) => t.stage === 'delivery')?.status === 'conflict' || o.status === 'needs_check' || d?.case.state === 'ESCALATED';
    const status = conflict ? 'needs_check' : o.billed > 0 ? 'partial' : 'not_billed';
    const headline = o.case_ref === MAIN_CASE
      ? `Delivered ${o.delivered} of ${o.ordered}. No invoice in Zoho.`
      : o.case_ref === SECOND_CASE ? `All ${o.delivered} delivered. Needs a second approver.` : o.headline ?? `${o.delivered} delivered, not billed.`;
    return {
      case_ref: o.case_ref!, customer_id: c.id, customer: c.name, po_ref: o.po_ref, headline, status: status as ToBillRow['status'],
      waiting_days: o.waiting_days, amount: qty * o.rate, proofs: o.proofs,
      approval_id: o.open_approval?.id ?? null, approvals_needed: o.open_approval?.required_approvers ?? 0, approvals_done: o.open_approval?.approvers.filter((x) => x.decision === 'approve').length ?? 0,
    };
  }).sort((a, b) => b.amount - a.amount);
}

const daysLate = (i: Inv) => i.due_days_ago;
export function chaseRows(mb: any): ChaseRow[] {
  const biz: Biz = mb.db.biz;
  const now = Date.now();
  return biz.invoices.filter((i) => !i.paid && daysLate(i) > 0).map((i) => {
    const c = custOf(biz, i.customer_id)!;
    const caseRef = biz.reminderCase[i.number];
    const apr = caseRef ? (Object.values(mb.db.approvals) as Approval[]).find((a) => a.case_id === caseRef && (a.status === 'pending' || a.status === 'partially_approved')) : null;
    return {
      invoice_number: i.number, customer_id: c.id, customer: c.name, amount: i.amount, due_date: new Date(now - i.due_days_ago * DAY).toISOString(), days_late: daysLate(i),
      reminder: { ...i.reminder, status: (apr ? 'draft' : i.reminder.status === 'draft' ? 'none' : i.reminder.status) as ChaseRow['reminder']['status'] }, snoozed_until: i.snoozed_until && new Date(i.snoozed_until).getTime() > now ? i.snoozed_until : null,
      note: i.note, approval_id: apr?.id ?? null,
    };
  }).sort((a, b) => (a.snoozed_until ? 1 : 0) - (b.snoozed_until ? 1 : 0) || b.days_late - a.days_late);
}

export function approvalCard(mb: any, a: Approval): ApprovalCard {
  const biz: Biz = mb.db.biz;
  const d: CaseDetail | undefined = mb.db.cases[a.case_id];
  const isRem = a.action_type === 'send_reminder';
  const o = biz.orders.find((x) => x.case_ref === a.case_id);
  const li = d?.proposal?.action.line_items?.[0];
  const prop = d?.proposal;
  const amount = a.amount ?? prop?.action.amount ?? 0;
  const gst = isRem ? 0 : Math.round(amount * gstRate(biz));
  const invNo = isRem ? Object.entries(biz.reminderCase).find(([, v]) => v === a.case_id)?.[0] : null;
  return {
    id: a.id, case_ref: a.case_id, customer: a.customer ?? d?.case.customer ?? '', po_ref: isRem ? invNo ?? '' : d?.case.reference ?? o?.po_ref ?? '',
    what: isRem ? `Payment reminder for ${invNo} · ${(d?.case.summary ?? '').replace(/^.*?·\s*/, '')}` : li ? `Bill ${li.qty}${o ? ` of ${o.ordered}` : ''} ${li.item} delivered · ${li.qty} × ₹${li.rate.toLocaleString('en-IN')}` : 'Invoice',
    amount, gst, total: amount + gst, approvers_needed: a.required_approvers,
    approvals: a.approvers.filter((x) => x.decision === 'approve').map((x) => ({ user: userName(x.email), at: x.ts ?? '' })),
    proofs: isRem ? [{ kind: 'zoho', label: invNo ?? 'Invoice', node_id: null }, { kind: 'whatsapp', label: 'Earlier reminders', node_id: null }] : o?.proofs ?? [],
    expires_reason: a.expires_reason ? plainExpiry(a.expires_reason) : null, kind: isRem ? 'reminder' : 'invoice', status: a.status, created_at: a.created_at,
    message: isRem ? prop?.action.message ?? null : null,
  };
}
function plainExpiry(r: string) {
  if (/correction|70 delivered/i.test(r)) return 'Ravi corrected the count from 60 to 70, so this approval was cancelled. A new one is waiting.';
  if (/edited/i.test(r)) return 'The invoice was edited, so this approval was cancelled.';
  if (/not billable/i.test(r)) return r;
  if (/evidence/i.test(r)) return 'The proof changed after this was sent, so it was cancelled. Please review the new one.';
  return r;
}

function custStats(mb: any, c: Cust) {
  const rows = toBillRows(mb).filter((r) => r.customer_id === c.id);
  const ch = chaseRows(mb).filter((r) => r.customer_id === c.id);
  const unpaidAll = mb.db.biz.invoices.filter((i: Inv) => i.customer_id === c.id && !i.paid).reduce((s: number, i: Inv) => s + i.amount, 0);
  const not_billed = rows.reduce((s, r) => s + r.amount, 0);
  const overdue = ch.reduce((s, r) => s + r.amount, 0);
  const late = c.avg_days - c.terms_days;
  const risk: Risk = late > 15 || c.ignored_reminders >= 3 ? 'high' : late > 0 ? 'watch' : 'good';
  const risk_reason = risk === 'high' ? (c.ignored_reminders >= 3 ? `Ignored ${c.ignored_reminders} reminders` : `Pays ${late} days late on average`) + ' (High risk: over 15 days late or 3 reminders ignored)'
    : risk === 'watch' ? `Pays ${late} days late on average (Watch: 1 to 15 days late)` : 'Pays within terms (Good)';
  return { not_billed, overdue, outstanding: not_billed + unpaidAll, risk, risk_reason, rows, ch };
}

export function flowFor(mb: any, period: string) {
  const biz: Biz = mb.db.biz;
  const days = period === 'quarter' ? 92 : 31;
  const os = biz.orders.map((o) => liveOrder(mb, o)).filter((o) => o.days_ago <= days || o.delivered > o.billed);
  const sum = (f: (o: Order) => number) => Math.round(os.reduce((s, o) => s + f(o) * o.rate, 0));
  const extraBilled = biz.invoices.filter((i) => i.created_now).reduce((s, i) => s + i.amount, 0);
  const ordered = sum((o) => o.ordered), delivered = sum((o) => o.delivered);
  // billed: history at taxable value; invoices created in this session at their GST-inclusive total (what went out)
  const billed = sum((o) => (o.case_ref && (biz.invoices.some((i) => i.po_ref === o.po_ref && i.created_now)) ? 0 : o.billed)) + extraBilled;
  const paid = sum((o) => o.paid);
  return { ordered, delivered, billed, paid };
}

export function dashboard(mb: any, period: string): DashboardSummary {
  const biz: Biz = mb.db.biz;
  const rows = toBillRows(mb);
  const ch = chaseRows(mb);
  const cards = (Object.values(mb.db.approvals) as Approval[]).filter((a) => a.status === 'pending' || a.status === 'partially_approved').sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).map((a) => approvalCard(mb, a));
  const leaks = biz.customers.map((c) => {
    const os = biz.orders.filter((o) => o.customer_id === c.id).map((o) => liveOrder(mb, o));
    const s = custStats(mb, c);
    return { customer_id: c.id, customer: c.name, delivered: os.reduce((t, o) => t + o.delivered * o.rate, 0), billed: os.reduce((t, o) => t + o.billed * o.rate, 0), paid: os.reduce((t, o) => t + o.paid * o.rate, 0), not_billed: s.not_billed, overdue: s.overdue };
  }).filter((l) => l.not_billed > 0).sort((a, b) => b.not_billed - a.not_billed);
  return {
    not_billed: { amount: rows.reduce((s, r) => s + r.amount, 0), count: rows.length, oldest_days: Math.max(0, ...rows.map((r) => r.waiting_days)) },
    overdue: { amount: ch.reduce((s, r) => s + r.amount, 0), count: ch.length, reminders_sent: ch.filter((r) => r.reminder.status !== 'none' && r.reminder.status !== 'draft').length },
    recovered: { amount: biz.recovered.base + biz.recovered.extra, invoices: biz.recovered.invoices + biz.recovered.extra_count, last_month: biz.recovered.last_month },
    waiting: { amount: cards.reduce((s, c) => s + c.total, 0), count: cards.length },
    flow: flowFor(mb, period), to_bill: rows.slice(0, 5), to_chase: ch.slice(0, 5), approvals: cards.slice(0, 5), leaks: leaks as any,
  };
}

// ---------------- case summary ----------------
const KIND_OF: Record<string, ProofKind> = { gmail: 'email', whatsapp: 'whatsapp', sheets: 'sheet', zoho: 'zoho', bank: 'bank', drive: 'pdf' };
function nodeProof(n: EvidenceNode): Proof {
  const kind: ProofKind = n.kind === 'photo' ? 'photo' : n.kind === 'voice_note' ? 'voice' : n.kind === 'document' ? 'pdf' : KIND_OF[n.source] ?? 'email';
  return { kind, label: n.title.replace(/\s*\((photo|read-back|decoy)\)/i, ''), node_id: n.id };
}

export function gstPreview(biz: Biz, c: Cust, lines: { item: string; hsn: string; qty: number; rate: number }[]): GstPreview {
  const taxable = lines.reduce((s, l) => s + l.qty * l.rate, 0);
  const r = gstRate(biz);
  const same = c.state_code === biz.settings.company.state_code;
  const half = Math.round((taxable * r) / 2 * 100) / 100;
  const cgst = same ? half : 0, sgst = same ? half : 0, igst = same ? 0 : Math.round(taxable * r * 100) / 100;
  const raw = taxable + cgst + sgst + igst;
  const total = Math.round(raw);
  return {
    seller_gstin: biz.settings.company.gstin, buyer_gstin: c.gstin, place_of_supply: `${c.state_code} - ${STATE_NAMES[c.state_code] ?? 'State'}`,
    lines: lines.map((l) => ({ ...l, taxable: l.qty * l.rate })), cgst, sgst, igst, round_off: Math.round((total - raw) * 100) / 100, total, total_words: rupeesInWords(total),
    irn_note: biz.settings.irn_warning ? 'E-invoice (IRN) may be needed if your yearly turnover is above ₹5 crore. Check with your CA.' : null,
  };
}
const STATE_NAMES: Record<string, string> = { '36': 'Telangana', '37': 'Andhra Pradesh', '29': 'Karnataka', '27': 'Maharashtra', '33': 'Tamil Nadu' };

const T = {
  headline: {
    en: (c: string, d: number, o: number, item: string) => d < o ? `${c} got ${d} of ${o} ${item}. Nobody billed them.` : `${c} got all ${d} ${item}. Nobody billed them.`,
    hi: (c: string, d: number, o: number, item: string) => `${c} को ${o} में से ${d} ${item} मिले। किसी ने बिल नहीं बनाया।`,
    te: (c: string, d: number, o: number, item: string) => `${c} కి ${o} లో ${d} ${item} అందాయి. ఎవరూ బిల్ చేయలేదు.`,
  },
  rec: {
    en: (q: number, rate: string, total: string, rest: number) => `Bill ${q} × ${rate} + GST = ${total} now.${rest > 0 ? ` Bill the other ${rest} when they are delivered.` : ''}`,
    hi: (q: number, rate: string, total: string, rest: number) => `अभी ${q} × ${rate} + GST = ${total} का बिल बनाएं।${rest > 0 ? ` बाकी ${rest} डिलीवरी के बाद।` : ''}`,
    te: (q: number, rate: string, total: string, rest: number) => `ఇప్పుడు ${q} × ${rate} + GST = ${total} బిల్ చేయండి.${rest > 0 ? ` మిగతా ${rest} డెలివరీ అయ్యాక.` : ''}`,
  },
  billed: {
    en: (inv: string, total: string) => `Billed: ${inv} for ${total}, checked in Zoho.`,
    hi: (inv: string, total: string) => `बिल बन गया: ${inv}, ${total}, Zoho में जाँचा गया।`,
    te: (inv: string, total: string) => `బిల్ అయింది: ${inv}, ${total}, Zoho లో తనిఖీ చేశాం.`,
  },
};
const rs = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');

export function caseSummary(mb: any, ref: string, lang: 'en' | 'hi' | 'te' = 'en'): CaseSummaryV2 {
  const biz: Biz = mb.db.biz;
  const d: CaseDetail | undefined = mb.db.cases[ref];
  if (!d) throw new ApiError(404, `case ${ref} not found`);
  const base = biz.orders.find((o) => o.case_ref === ref);
  const o = base ? liveOrder(mb, base) : null;
  const c = custOf(biz, o?.customer_id ?? d.case.customer_id) ?? { id: d.case.customer_id ?? '', name: d.case.customer ?? 'Customer', city: '', gstin: '—', state_code: '36', terms_days: 30, avg_days: 30, contact_name: '', phone: '', since: '', ignored_reminders: 0 };
  const approvals = (Object.values(mb.db.approvals) as Approval[]).filter((a) => a.case_id === ref);
  const open = approvals.filter((a) => a.status === 'pending' || a.status === 'partially_approved').sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0] ?? null;
  const nodes = d.evidence.nodes;
  const f = d.facts;
  const item = d.proposal?.action.line_items[0]?.item ?? o?.item ?? 'items';
  const ordered = f?.order_qty ?? o?.ordered ?? 0;
  const delivered = f?.delivered_qty ?? o?.delivered ?? 0;
  const rate = f?.rate ?? o?.rate ?? 0;
  const billQty = d.proposal?.action.line_items[0]?.qty ?? Math.max(0, delivered - (o?.billed ?? 0));
  const invoiceAct = d.actions.find((a) => a.type === 'create_invoice' && a.status === 'succeeded');
  const L = lang;

  // facts (proof rows)
  const facts: Fact[] = [];
  const orderNode = nodes.find((n) => (n.kind === 'email' || n.kind === 'message' || n.kind === 'sales_order') && !n.untrusted_flag && /PO|order/i.test(n.title) && n.fields?.qty);
  if (orderNode) facts.push({ id: 'ordered', label: 'Ordered', value: `${ordered} × ${item} at ${rs(rate)}`, source: nodeProof(orderNode), changed_from: null, at: orderNode.ts });
  const corr = nodes.find((n) => n.id === 'ev_wa_correction' || n.kind === 'correction');
  const challan = nodes.find((n) => n.kind === 'photo');
  if (delivered || corr || challan) {
    const src = corr ?? challan ?? nodes.find((n) => n.kind === 'sheet_row' || n.kind === 'delivery_record') ?? orderNode;
    const prevQty = corr ? String(corr.fields?.was ?? (challan?.fields?.qty ?? 60)) : null;
    facts.push({ id: 'delivered', label: 'Delivered', value: `${delivered} ${/box|carton/i.test(item) ? '' : ''}${item === 'Model X' || item === 'Model Y' || item === 'Model Z' ? 'boxes' : 'units'}`.trim(), source: src ? nodeProof(src) : { kind: 'sheet', label: 'Delivery sheet' }, changed_from: corr && prevQty !== String(delivered) ? prevQty : null, at: src?.ts ?? null });
  }
  if (challan && challan !== corr) facts.push({ id: 'challan', label: 'Challan photo', value: String(challan.excerpt ?? '').replace(/^Vision:\s*/, '').replace(/[“”"]/g, ''), source: nodeProof(challan), changed_from: null, at: challan.ts, highlight: ['PO', 'customer', 'quantity'] });
  const voice = nodes.find((n) => n.kind === 'voice_note');
  if (voice) facts.push({ id: 'voice', label: 'Voice note', value: `"${voice.derived_text ?? ''}"`, source: nodeProof(voice), changed_from: null, at: voice.ts });
  const sheet = nodes.find((n) => n.kind === 'sheet_row' || n.kind === 'delivery_record');
  if (sheet) facts.push({ id: 'sheet', label: 'Dispatch sheet', value: String(sheet.excerpt ?? ''), source: nodeProof(sheet), changed_from: null, at: sheet.ts });
  if (invoiceAct) facts.push({ id: 'invoice', label: 'Invoice in Zoho', value: `${invoiceAct.target_id} created and read back`, source: { kind: 'zoho', label: invoiceAct.target_id ?? 'Zoho', node_id: nodes.find((n) => n.kind === 'invoice' && !n.ruled_out)?.id ?? null }, changed_from: null, at: invoiceAct.ts ?? null });
  else if (d.case.state !== 'INTAKE' && d.case.state !== 'TRIAGED') {
    const alt = nodes.find((n) => n.id === 'ev_zo_altids' || (n.source === 'zoho' && /no |negative|0 invoices/i.test(n.title)));
    facts.push({ id: 'zoho', label: 'Zoho Books', value: `No invoice for ${d.case.reference}${alt ? ' (also searched other references and the amount)' : ''}`, source: alt ? nodeProof(alt) : { kind: 'zoho', label: 'Zoho search' }, changed_from: null, at: alt?.ts ?? null });
  }
  const bank = nodes.find((n) => n.source === 'bank');
  if (bank) facts.push({ id: 'bank', label: 'Bank', value: 'No payment received yet', source: nodeProof(bank), changed_from: null, at: bank.ts });

  // callouts
  const callouts: CaseSummaryV2['callouts'] = [];
  for (const a of approvals.filter((x) => x.status === 'expired')) callouts.push({ kind: 'approval_expired', text: `An approval for ${rs(a.amount ?? 0)} was cancelled: ${plainExpiry(a.expires_reason ?? '').replace(/, so this approval was cancelled\.?/, '.')} Old approvals can never be used.` });
  for (const n of nodes.filter((x) => x.untrusted_flag)) callouts.push({ kind: 'quarantined', text: `An email from ${n.fields?.from ?? 'an unknown sender'} said "${String(n.excerpt ?? '').split('.')[0]}". It was kept aside: messages are treated as data, never as instructions. Nothing changed.` });
  if (corr && !approvals.some((a) => a.status === 'expired')) callouts.push({ kind: 'corrected', text: `The count was corrected to ${delivered}. We re-checked everything.` });

  // journey
  const cps = d.checkpoints;
  const firstAt = (states: string[]) => cps.find((cp) => states.includes(cp.state))?.ts ?? null;
  const prevMain = [...cps].reverse().find((cp) => !['PAUSED', 'ESCALATED', 'BLOCKED'].includes(cp.state))?.state ?? null;
  const resume = cps.at(-1)?.payload?.resume_to as any;
  const fin = USERS.filter((u) => u.role === 'finance_approver' && !(open?.approvers ?? []).some((x) => x.email === u.email)).map((u) => u.name?.split(' ')[0]);
  const invNo = invoiceAct?.target_id ?? null;
  const total = withGst(biz, billQty * rate);
  const zohoDown = mb.db.connectors?.zoho?.status === 'degraded';
  const retry = new Date(Date.now() + 15 * 60e3).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const inv = invNo ? biz.invoices.find((i) => i.number === invNo) : null;
  const journey = buildJourney({
    state: d.case.state, prevState: resume ?? prevMain, paid: inv?.paid,
    waitingFor: open ? (open.required_approvers > 1 && open.approvers.length ? `2nd approver (${fin[0] ?? 'finance'})` : fin[0] ?? 'finance') : null,
    problem: d.case.state === 'PAUSED' ? (zohoDown ? { reason: 'Zoho is down.', next: `We'll retry at ${retry}. Nothing was billed twice.` } : { reason: 'Paused safely.', next: 'It resumes from the last step by itself. Nothing was billed twice.' }) : d.case.state === 'ESCALATED' ? { reason: o?.status === 'needs_check' ? 'The counts do not match.' : 'We could not finish this safely.', next: 'Check the proof below and fix the count with "This is wrong".' } : null,
    at: { received: firstAt(['INTAKE']), read: firstAt(['TRIAGED', 'WATCHING']), matched: firstAt(['WATCHING', 'EVIDENCE_READY']), checked: firstAt(['PROPOSED', 'AWAITING_APPROVAL']), waiting: firstAt(['EXECUTING']), invoiced: firstAt(['VERIFYING']), verified: firstAt(['CLOSED']) },
    captions: {
      read: voice && challan ? 'photo + voice' : null, matched: d.case.reference ?? null, checked: delivered ? `${delivered} of ${ordered}` : null,
      waiting: open ? null : approvals.some((a) => a.status === 'approved') ? `by ${userName(approvals.find((a) => a.status === 'approved')?.approvers.at(-1)?.email)}` : null,
      invoiced: invNo, verified: d.verification?.status === 'passed' ? 'matches' : null, paid: inv ? `due ${new Date(Date.now() + (c.terms_days - (inv.issued_days_ago ?? 0)) * DAY).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}` : null,
    },
  });

  const documents: CaseSummaryV2['documents'] = [
    { stage: 'order', status: orderNode ? 'found' : 'missing', date: orderNode?.ts ?? null, source: orderNode ? (orderNode.source === 'gmail' ? 'Email' : orderNode.source === 'whatsapp' ? 'WhatsApp' : 'Zoho') : null, key_number: d.case.reference ?? null },
    { stage: 'delivery', status: (d.timeline.find((t) => t.stage === 'delivery')?.status ?? 'missing') as any, date: (corr ?? challan ?? sheet)?.ts ?? null, source: challan ? 'WhatsApp challan' : sheet ? 'Dispatch sheet' : null, key_number: delivered ? `${challan?.fields?.challan ? challan.fields.challan + ' · ' : ''}${delivered} of ${ordered}` : null },
    { stage: 'invoice', status: invNo ? 'found' : 'missing', date: invoiceAct?.ts ?? null, source: invNo ? 'Zoho Books' : 'Not in Zoho', key_number: invNo },
    { stage: 'payment', status: inv?.paid ? 'found' : 'missing', date: null, source: inv ? 'Bank' : null, key_number: inv ? (inv.paid ? 'Paid' : 'Not due yet') : null },
  ];

  const sources = new Set([challan, voice, sheet, corr].filter(Boolean).map((n) => n!.source));
  const conflict = d.timeline.find((t) => t.stage === 'delivery')?.status === 'conflict' || d.case.state === 'ESCALATED';
  const confidence: 'high' | 'needs_check' = conflict || !delivered ? 'needs_check' : 'high';
  const confidence_reason = conflict ? 'The challan and the sheet disagree on the count.' : !delivered ? 'No delivery proof yet.' : corr ? `The latest message from the same dispatch person says ${delivered}; the sheet and photo match the rest.` : `${Math.max(sources.size, 1)} separate source${sources.size > 1 ? 's' : ''} agree on ${delivered} delivered.`;

  const runs = d.agent_runs;
  const trace = mb.db.trace[ref] ?? [];
  const tools = trace.filter((e: any) => e.type === 'tool_call');
  const invTools = tools.filter((e: any) => e.agent === 'investigation').map((e: any) => String(e.data?.tool));
  const EXTRA: Record<string, string> = { search_alt_ids: 'Searched Zoho for other references (PO184, 184, SO-0091)', search_credit_notes: 'Checked credit notes', bank_get_payments: 'Checked the bank statement for a payment', get_billing_rules: 'Read your partial-delivery billing rule', whatsapp_search: 'Checked the correction came from the same dispatch person', zoho_get_invoices: 'Re-checked nobody billed it by hand' };
  let secs = 0;
  for (let i = 1; i < trace.length; i++) { const g = (new Date(trace[i].ts).getTime() - new Date(trace[i - 1].ts).getTime()) / 1000; if (g > 0 && g < 10) secs += g; }
  secs = Math.round(secs);

  const qtyToBill = Math.max(0, billQty);
  const already = o && !invNo ? o.billed : 0;
  const headline = invNo ? T.billed[L](invNo, rs(total)) : already > 0 && L === 'en' ? `${c.name.replace(/ Pvt Ltd| LLP/, '')} got ${delivered} ${item}, but only ${already} were billed.` : delivered ? T.headline[L](c.name.replace(/ Pvt Ltd| LLP/, ''), delivered, ordered, item) : `${c.name}: order ${d.case.reference} is open. Waiting for delivery proof.`;
  const recommendation = invNo ? (L === 'en' ? 'Nothing to do now. We will watch for the payment and remind politely if it is late.' : L === 'hi' ? 'अभी कुछ नहीं करना है। भुगतान पर नज़र रखेंगे।' : 'ఇప్పుడు చేయాల్సింది ఏమీ లేదు. చెల్లింపు కోసం చూస్తాం.')
    : delivered ? (conflict ? 'Check the count first. Fix it with "This is wrong" on the right row, then approve.' : T.rec[L](qtyToBill, rs(rate), rs(total), Math.max(0, ordered - delivered))) : 'Nothing to bill yet. Link the delivery photo or voice note when it comes.';

  const days = o?.waiting_days ?? 0;
  const status_label = invNo ? 'BILLED · CHECKED IN ZOHO' : open ? (open.required_approvers > 1 && open.approvers.length ? `WAITING FOR 2ND APPROVER · ${days} DAYS` : `NOT BILLED · ${days} DAYS`) : conflict ? 'NEEDS CHECK' : delivered ? `NOT BILLED · ${days} DAYS` : 'WATCHING';
  return {
    case_ref: ref, po_ref: d.case.reference ?? '', customer: c.name, customer_id: c.id, headline, recommendation, confidence, confidence_reason, journey, documents, facts, callouts,
    invoice_preview: delivered && !conflict ? gstPreview(biz, c as Cust, [{ item, hsn: o?.hsn ?? '8481', qty: qtyToBill, rate }]) : null,
    approval: open ? approvalCard(mb, open) : null,
    how_found: { agents: new Set(runs.map((r) => r.agent)).size, checks: tools.length, seconds: secs, extra_searches: Array.from(new Set(invTools)).map((t) => EXTRA[t as string] ?? t as string) },
    state: d.case.state, status_label, waiting_days: days,
    ...((d as any).v3 ? { timeline: (d as any).v3.timeline, timeline_decision: (d as any).v3.timeline_decision, chat_memory: (d as any).v3.chat_memory } : {}),
  };
}

// ---------------- writes ----------------
export function nextInvoiceNumber(mb: any, caseId: string) {
  const biz: Biz | undefined = mb.db.biz;
  if (caseId === MAIN_CASE) return 'INV-2231';
  if (!biz) return 'INV-2299';
  biz.invSeq = Math.max(biz.invSeq, 2231) + 1;
  return `INV-${biz.invSeq}`;
}

/** Called by the gateway after a verified write. */
export function onExecuted(mb: any, a: Approval, target: string) {
  const biz: Biz | undefined = mb.db.biz;
  if (!biz) return;
  const d: CaseDetail = mb.db.cases[a.case_id];
  if (a.action_type === 'send_reminder') {
    const inv = Object.entries(biz.reminderCase).find(([, v]) => v === a.case_id)?.[0];
    const i = biz.invoices.find((x) => x.number === inv);
    if (i) {
      i.reminder = { stage: i.reminder.stage || 7, status: 'sent' };
      i.followups.push({ days_ago: 0, kind: `Reminder ${i.followups.length + 1} · WhatsApp · UPI link`, text: 'Sent after your approval · waiting for reply', status: 'sent' });
      i.note = 'reminder sent today';
      delete biz.reminderCase[i.number];
    }
    return;
  }
  const o = biz.orders.find((x) => x.case_ref === a.case_id);
  if (!o || !d?.proposal) return;
  const taxable = d.proposal.action.amount;
  const total = withGst(biz, taxable);
  if (!biz.invoices.some((i) => i.number === target)) {
    biz.invoices.unshift({ number: target, customer_id: o.customer_id, po_ref: o.po_ref, amount: total, issued_days_ago: 0, due_days_ago: -(custOf(biz, o.customer_id)?.terms_days ?? 30), paid: false, reminder: { stage: 0, status: 'none' }, snoozed_until: null, note: null, followups: [], case_ref: a.case_id, created_now: true });
    biz.recovered.extra += total;
    biz.recovered.extra_count += 1;
  }
  mb.agentEv?.(a.case_id, 'gateway', 'resolution', 'tool_result', { tool: 'zoho_create_invoice', ok: true, found: { doc: 'invoice', number: target, total } });
}
export function onVerified(mb: any, a: Approval, target: string) {
  const biz: Biz | undefined = mb.db.biz;
  if (!biz || a.action_type === 'send_reminder') return;
  const inv = biz.invoices.find((i) => i.number === target);
  if (inv) {
    mb.agentEv?.(a.case_id, 'verifier', 'resolution', 'tool_result', { tool: 'zoho_read_back', ok: true, found: { doc: 'verified', total: inv.amount } });
    setTimeout(() => mb.agentEv?.(a.case_id, 'verifier', 'resolution', 'tool_result', { tool: 'recovered', ok: true, found: { doc: 'recovered', total: inv.amount } }), 900);
  }
}

export function draftReminder(mb: any, invNo: string, stage: number, silent = false): Approval {
  const biz: Biz = mb.db.biz;
  const i = biz.invoices.find((x) => x.number === invNo);
  if (!i) throw new ApiError(404, `invoice ${invNo} not found`);
  const c = custOf(biz, i.customer_id)!;
  const existing = biz.reminderCase[invNo] ? (Object.values(mb.db.approvals) as Approval[]).find((a) => a.case_id === biz.reminderCase[invNo] && (a.status === 'pending' || a.status === 'partially_approved')) : null;
  if (existing) return existing;
  const vpa = biz.settings.company.upi_vpa;
  const upi = `upi://pay?pa=${vpa}&pn=${encodeURIComponent(biz.settings.company.name)}&am=${i.amount}&tn=${i.number}`;
  const firm = stage >= 30;
  const msg = firm
    ? `Hi ${c.contact_name}, ${i.number} for ${rs(i.amount)} is now ${i.due_days_ago} days past due. Please pay today or tell us the date: ${upi}`
    : `Hi ${c.contact_name}, a gentle follow-up on ${i.number} for ${rs(i.amount)}, now ${i.due_days_ago} days past due. You can pay here: ${upi}. Please let us know if anything is holding it up.`;
  const id = `RG-${(1100 + biz.invoices.indexOf(i)).toString()}`;
  biz.reminderCase[invNo] = id;
  const now = mb.now();
  mb.db.cases[id] = {
    case: { id, state: 'AWAITING_APPROVAL', customer: c.name, customer_id: c.id, reference: invNo, amount: i.amount, exception_type: 'partial_payment', severity: i.due_days_ago > 30 ? 'high' : 'medium', correlation_id: `rem-${invNo}`, evidence_version: 1, created_at: now, updated_at: now, summary: `${i.due_days_ago} days late · ${firm ? 'firmer tone' : 'polite'}` },
    timeline: [{ stage: 'order', status: 'found', evidence_node_ids: [] }, { stage: 'delivery', status: 'found', evidence_node_ids: [] }, { stage: 'invoice', status: 'found', evidence_node_ids: [] }, { stage: 'payment', status: 'missing', evidence_node_ids: [] }],
    evidence: { nodes: [], edges: [] }, agent_runs: [], checkpoints: [{ seq: 1, state: 'AWAITING_APPROVAL', evidence_version: 1, ts: now }],
    proposal: { id: `prop_rem_${invNo}`, version: 1, risk: 'low', action: { type: 'send_reminder', customer_id: c.id, customer_name: c.name, reference: invNo, line_items: [{ item: `Reminder ${invNo}`, qty: 1, rate: i.amount }], amount: i.amount, channel: 'whatsapp', message: msg }, claims: [], uncertainty: [] },
    approvals: [], actions: [], verification: null, laya: null, facts: null,
  } as CaseDetail;
  mb.db.trace[id] = [];
  i.reminder = { stage: (stage as any) || 7, status: 'draft' };
  const a: Approval = mb.createApproval(id, mb.db.cases[id].proposal, silent);
  a.required_approvers = 1;
  return a;
}

/** "This is wrong": a corrected fact is a new evidence version. Open approvals expire; the validator re-runs. */
export async function correctFact(mb: any, ref: string, factId: string, value: string, note: string, me: User) {
  const d: CaseDetail = mb.db.cases[ref];
  if (!d) throw new ApiError(404, 'case not found');
  if (me.role === 'viewer') throw new ApiError(403, 'role_block: viewers cannot correct facts');
  const biz: Biz = mb.db.biz;
  if (factId === 'delivered' || factId === 'delivered_qty' || factId === 'challan' || factId === 'sheet' || factId === 'voice') {
    const qty = parseInt(String(value).replace(/[^\d]/g, ''), 10);
    if (!(qty >= 0)) throw new ApiError(400, 'Please enter the delivered quantity as a number.');
    const o = biz.orders.find((x) => x.case_ref === ref);
    const f = d.facts ?? { order_qty: o?.ordered ?? qty, rate: o?.rate ?? 0, rule: 'bill_delivered_qty' } as any;
    if (qty > (f.order_qty ?? qty)) throw new ApiError(400, `That is more than the ${f.order_qty} ordered. Please check.`);
    const was = f.delivered_qty ?? 0;
    const prevV = d.case.evidence_version ?? 0;
    mb.addNode(ref, { id: `ev_fix_${Date.now().toString(36)}`, kind: 'correction', source: 'whatsapp', source_id: `user:${me.email}`, ts: mb.now(), title: `Correction by ${userName(me.email)}: ${qty} delivered`, excerpt: note || `Corrected from ${was} to ${qty}`, fields: { qty, was, by: me.email } });
    mb.auditRow({ case_id: ref, actor: me.email, action: 'fact.correct', detail: `delivered ${was} → ${qty} · evidence v${prevV} → v${d.case.evidence_version}${note ? ' · ' + note : ''}` });
    for (const a of Object.values(mb.db.approvals) as Approval[]) {
      if (a.case_id === ref && (a.status === 'pending' || a.status === 'partially_approved')) {
        a.status = 'expired';
        a.expires_reason = `evidence_version v${prevV} → v${d.case.evidence_version} (corrected by ${me.email}: ${qty} delivered)`;
        mb.emit({ type: 'approval.updated', approval: a });
        mb.guardrail(ref, 'approval_expired', `${a.id} for ₹${(a.amount ?? 0).toLocaleString('en-IN')} expired: fact corrected (${was} → ${qty}).`);
      }
    }
    const rate = f.rate ?? o?.rate ?? 0;
    d.facts = { ...f, delivered_qty: qty, billable_qty: qty, billable_amount: qty * rate, evidence_version: d.case.evidence_version, check: { amount_matches: true, claims_cited: true, errors: [] } };
    const t = d.timeline.find((x) => x.stage === 'delivery');
    if (t) { t.status = qty >= (f.order_qty ?? qty) ? 'found' : 'partial'; t.note = `${qty} of ${f.order_qty} (corrected)`; }
    mb.transition(ref, 'VALIDATED', { facts: d.facts, reason: `re-validated after correction: billable ₹${(qty * rate).toLocaleString('en-IN')}` }, 'validator');
    mb.auditRow({ case_id: ref, actor: 'validator', action: 'validator.compute_billable', detail: `delivered_qty=${qty} × ${rate} = ${qty * rate}` });
    if (qty > 0) {
      const base = d.proposal ?? orderProposal(o ?? { po_ref: d.case.reference ?? '', customer_id: d.case.customer_id ?? '', item: 'Item', rate, ordered: f.order_qty }, d.case.customer ?? '', 0, qty);
      const li = base.action.line_items[0];
      const p: Proposal = { ...base, id: `prop_${ref.slice(3)}_v${(base.version ?? 1) + 1}`, version: (base.version ?? 1) + 1, created_at: mb.now(), action: { ...base.action, line_items: [{ ...li, qty, rate }], amount: qty * rate }, validation: { ok: true, errors: [] } };
      d.proposal = p;
      mb.transition(ref, 'PROPOSED', { proposal_id: p.id });
      mb.createApproval(ref, p);
      mb.transition(ref, 'AWAITING_APPROVAL', { proposal_id: p.id });
    }
    return { ok: true, evidence_version: d.case.evidence_version };
  }
  if (factId === 'ordered' || factId === 'customer') {
    biz.aliases.push({ kind: factId === 'customer' ? 'customer' : 'po', alias: value, canonical: factId === 'customer' ? d.case.customer ?? '' : d.case.reference ?? '' });
    mb.auditRow({ case_id: ref, actor: me.email, action: 'alias.learned', detail: `"${value}" = ${d.case.customer}` });
    return { ok: true, evidence_version: d.case.evidence_version };
  }
  throw new ApiError(400, 'This fact cannot be changed here. Use Edit on the invoice instead.');
}

// ---------------- ask (deterministic, read-only) ----------------
export function ask(mb: any, question: string, lang?: string): AskAnswer {
  const q = question.toLowerCase();
  const biz: Biz = mb.db.biz;
  const write = /\b(approve|send|create|delete|mark|pay|cancel|write off|change)\b|मंज़ूर|भेज|ఆమోద|పంపు/.test(q);
  if (write) return { answer: 'I can only read and explain. Approving, billing and sending always go through the approval screen, so a person checks every rupee.', table: null, proofs: [], actions: [{ label: 'Open approvals', href: '/approvals' }, { label: 'Open To bill', href: '/bill' }] };
  const po = q.match(/po[-\s]?(\d{3})/);
  const rg = q.match(/rg[-\s]?(\d{4})/);
  if (po || rg) {
    const o = po ? biz.orders.find((x) => x.po_ref === `PO-${po[1]}`) : null;
    const ref = rg ? `RG-${rg[1]}` : o?.case_ref;
    if (ref && mb.db.cases[ref]) {
      const s = caseSummary(mb, ref, (lang as any) || 'en');
      return { answer: `${s.headline} ${s.recommendation}`, table: { columns: ['Fact', 'Value', 'Source'], rows: s.facts.map((f) => [f.label, f.value, f.source.label]) }, proofs: s.facts.slice(0, 4).map((f) => f.source), actions: [{ label: `Open ${s.po_ref}`, href: `/case?id=${ref}` }] };
    }
    if (o) { const lo = liveOrder(mb, o); return { answer: `${o.po_ref}: ordered ${o.ordered}, delivered ${lo.delivered}, billed ${lo.billed}, paid ${o.paid}. Invoice ${lo.invoice ?? 'not yet created'}.`, table: null, proofs: [{ kind: 'zoho', label: lo.invoice ?? 'Zoho' }], actions: [] }; }
    return { answer: `I could not find ${po ? 'PO-' + po[1] : 'RG-' + rg![1]}. Check the number, or look in Unlinked.`, table: null, proofs: [], actions: [{ label: 'Open Unlinked', href: '/unlinked' }] };
  }
  if (/overdue|late|chase|collect|बकाया|వసూలు|ఆలస్యం/.test(q) && !/owe/.test(q)) {
    const rows = chaseRows(mb);
    const tot = rows.reduce((s, r) => s + r.amount, 0);
    return { answer: `${rows.length} invoices are overdue, ${rs(tot)} in total. ${rows[0] ? `${rows[0].customer} is the latest: ${rows[0].days_late} days.` : ''}`, table: { columns: ['Customer', 'Invoice', 'Amount', 'Days late', 'Reminder'], rows: rows.map((r) => [r.customer, r.invoice_number, rs(r.amount), r.days_late, r.reminder.status]) }, proofs: rows.slice(0, 3).map((r) => ({ kind: 'zoho' as const, label: r.invoice_number })), actions: [{ label: 'Draft reminders for the overdue ones', href: '/collect' }] };
  }
  if (/not billed|unbilled|bill|बिल|బిల్/.test(q) && !/owe/.test(q)) {
    const rows = toBillRows(mb);
    const tot = rows.reduce((s, r) => s + r.amount, 0);
    return { answer: `${rows.length} deliveries are not billed, ${rs(tot)} before GST. The oldest is ${Math.max(...rows.map((r) => r.waiting_days))} days.`, table: { columns: ['Customer', 'PO', 'Not billed', 'Waiting'], rows: rows.map((r) => [r.customer, r.po_ref, rs(r.amount), `${r.waiting_days} days`]) }, proofs: rows.slice(0, 3).flatMap((r) => r.proofs.slice(0, 1)), actions: [{ label: 'Open To bill', href: '/bill' }] };
  }
  // default + "who owes me": customers by total owed (optionally above a threshold)
  const lakh = q.match(/(\d+(?:\.\d+)?)\s*(lakh|l\b|लाख|లక్ష)/);
  const min = lakh ? parseFloat(lakh[1]) * 1e5 : /owe|బాకీ|बाकी|बकाया|owes|most/.test(q) ? 0 : -1;
  if (min < 0) return { answer: 'Ask me about money: who owes you, what is not billed, what is overdue, or any PO number. For example: "Which customers owe me more than ₹1 lakh?"', table: null, proofs: [], actions: [{ label: 'Who owes me the most?', href: '/ask?q=' + encodeURIComponent('Who owes me the most this month?') }, { label: 'What is not billed?', href: '/ask?q=' + encodeURIComponent('What is not billed yet?') }] };
  const rows = biz.customers.map((c) => ({ c, s: custStats(mb, c) })).map(({ c, s }) => ({ c, nb: s.not_billed, od: s.overdue, total: s.not_billed + s.overdue, rows: s.rows, ch: s.ch })).filter((r) => r.total > Math.max(min, 0)).sort((a, b) => b.total - a.total);
  const total = rows.reduce((s, r) => s + r.total, 0);
  const nb = rows.reduce((s, r) => s + r.nb, 0);
  const top = rows[0];
  const L = (lang || 'en') as 'en' | 'hi' | 'te';
  const answer = !top ? 'Nobody owes you that much right now.'
    : L === 'te' ? `${top.c.name} ${rs(top.total)} బాకీ ఉన్నారు. అందులో ${rs(top.nb)} ఇంకా బిల్ చేయలేదు. మొత్తం ${rows.length} కస్టమర్లు, ${rs(total)}.`
    : L === 'hi' ? `${rows.length} ग्राहकों पर ${rs(total)} बाकी है। ${top.c.name} पर सबसे ज़्यादा ${rs(top.total)}, जिसमें ${rs(top.nb)} का बिल अभी नहीं बना।`
    : `${rows.length} customer${rows.length > 1 ? 's' : ''} owe you ${min > 0 ? `more than ${rs(min)}` : 'money'}, ${rs(total)} in total. ${nb > total / 2 ? `Most of it isn't even billed yet: ${rs(nb)} is delivered but not invoiced.` : `${rs(nb)} of it is not billed yet.`} ${top.c.name} is the biggest.`;
  return {
    answer, note: `From Zoho Books, the dispatch sheet and WhatsApp · checked just now${min > 0 ? '' : ''}`,
    table: { columns: ['Customer', 'Not billed', 'Overdue', 'Total owed', 'Oldest', 'Proof'], rows: rows.map((r) => [r.c.name, rs(r.nb), rs(r.od), rs(r.total), r.rows[0] ? `${r.rows[0].po_ref} · ${r.rows[0].waiting_days} days` : r.ch[0] ? `${r.ch[0].invoice_number} · ${r.ch[0].days_late} days` : '—', `${r.rows.reduce((s, x) => s + x.proofs.length, 0) + r.ch.length * 2} records`]) },
    proofs: rows.slice(0, 3).flatMap((r) => r.rows[0]?.proofs.slice(0, 1) ?? []),
    actions: [
      ...(rows.some((r) => r.nb > 0) ? [{ label: `Bill ${rows.filter((r) => r.nb > 0).length === 1 ? 'it' : 'these'} now`, href: '/bill' }] : []),
      ...(rows.some((r) => r.od > 0) ? [{ label: 'Draft reminders for the overdue ones', href: '/collect' }] : []),
      ...(top?.rows[0] ? [{ label: `Why wasn't ${top.rows[0].po_ref} billed?`, href: `/case?id=${top.rows[0].case_ref}` }] : []),
    ],
  };
}

// ---------------- router ----------------
export async function handleV2(mb: any, method: string, path: string, params: URLSearchParams, body: any, me: User): Promise<any> {
  const biz: Biz = mb.db.biz;
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  const need = (roles: string[]) => { if (!roles.includes(me.role)) { mb.guardrail('', 'role_block', `${me.email} (${me.role}) tried ${method} ${path}`); throw new ApiError(403, `role_block: ${me.role} cannot do this`); } };

  if (path === '/dashboard/summary') return dashboard(mb, params.get('period') ?? 'month');
  if (path === '/events/recent') return { events: [] };

  if (seg[0] === 'bill') {
    if (seg.length === 1) {
      let rows = toBillRows(mb);
      const st = params.get('status'), cu = params.get('customer'), qq = (params.get('q') ?? '').toLowerCase();
      if (st) rows = rows.filter((r) => st.split(',').includes(r.status));
      if (cu) rows = rows.filter((r) => r.customer_id === cu);
      if (qq) rows = rows.filter((r) => `${r.customer} ${r.po_ref} ${r.case_ref}`.toLowerCase().includes(qq));
      return { items: rows, total_amount: rows.reduce((s, r) => s + r.amount, 0), not_billable: biz.orders.filter((o) => o.not_billable).map((o) => ({ po_ref: o.po_ref, customer: custOf(biz, o.customer_id)?.name, ...o.not_billable })) };
    }
    if (seg[2] === 'not-billable' && method === 'POST') {
      need(['operator', 'admin', 'finance_approver']);
      const o = biz.orders.find((x) => x.case_ref === seg[1]);
      if (!o) throw new ApiError(404, 'not found');
      o.not_billable = { reason: body?.reason ?? 'other', note: body?.note ?? '', at: mb.now() };
      for (const a of Object.values(mb.db.approvals) as Approval[]) if (a.case_id === seg[1] && (a.status === 'pending' || a.status === 'partially_approved')) { a.status = 'expired'; a.expires_reason = `Marked not billable (${o.not_billable.reason}) by ${userName(me.email)}`; mb.emit({ type: 'approval.updated', approval: a }); }
      mb.auditRow({ case_id: seg[1], actor: me.email, action: 'bill.not_billable', detail: `${o.po_ref}: ${o.not_billable.reason}${o.not_billable.note ? ' · ' + o.not_billable.note : ''}` });
      mb.touch(seg[1]);
      return { ok: true };
    }
  }
  if (seg[0] === 'collect') {
    if (seg.length === 1) {
      let rows = chaseRows(mb);
      const b = params.get('bucket') ?? 'all';
      const rng: Record<string, [number, number]> = { '0-7': [0, 7], '8-30': [8, 30], '31-60': [31, 60], '60+': [61, 1e9] };
      if (rng[b]) rows = rows.filter((r) => r.days_late >= rng[b][0] && r.days_late <= rng[b][1]);
      return { items: rows, total_amount: rows.reduce((s, r) => s + r.amount, 0) };
    }
    const i = biz.invoices.find((x) => x.number === seg[1]);
    if (!i) throw new ApiError(404, 'invoice not found');
    if (seg[2] === 'snooze') {
      need(['operator', 'admin', 'finance_approver']);
      const days = Math.max(1, Math.min(60, Number(body?.days) || 7));
      i.snoozed_until = new Date(Date.now() + days * DAY).toISOString();
      i.note = `snoozed ${days} days: ${body?.reason || 'no reason'}`;
      mb.auditRow({ actor: me.email, action: 'collect.snooze', detail: `${i.number} · ${days} days · ${body?.reason ?? ''}` });
      mb.emit({ type: 'case.updated', case_id: '', state: 'WATCHING' as any });
      return { ok: true, snoozed_until: i.snoozed_until };
    }
    if (seg[2] === 'draft-reminder') {
      need(['operator', 'admin', 'finance_approver']);
      const a = draftReminder(mb, i.number, Number(body?.stage) || (i.due_days_ago >= 30 ? 30 : i.due_days_ago >= 15 ? 15 : 7));
      mb.auditRow({ case_id: a.case_id, actor: me.email, action: 'collect.draft_reminder', detail: `${i.number} · stage ${body?.stage ?? ''} · waits for approval` });
      return approvalCard(mb, a);
    }
  }
  if (seg[0] === 'cases' && seg[2] === 'summary') return caseSummary(mb, seg[1], (params.get('lang') as any) || 'en');
  if (seg[0] === 'cases' && seg[2] === 'facts' && seg[4] === 'correct') return correctFact(mb, seg[1], seg[3], String(body?.value ?? ''), String(body?.note ?? ''), me);

  if (path === '/approvals/bulk-approve') {
    const results = [];
    for (const id of (body?.ids ?? []) as string[]) {
      try { await mb.approve(id, me, 'Bulk approve from To bill'); results.push({ id, ok: true, detail: 'approved' }); }
      catch (e: any) { results.push({ id, ok: false, detail: e?.message ?? String(e) }); }
    }
    return { results };
  }

  if (seg[0] === 'customers') {
    if (seg.length === 1) {
      return biz.customers.map((c) => {
        const s = custStats(mb, c);
        return { id: c.id, name: c.name, gstin: c.gstin, city: c.city, outstanding: s.outstanding, overdue: s.overdue, not_billed: s.not_billed, avg_days_to_pay: c.avg_days, terms_days: c.terms_days, risk: s.risk, risk_reason: s.risk_reason } as CustomerRow;
      }).sort((a, b) => (b.not_billed ?? 0) + b.overdue - ((a.not_billed ?? 0) + a.overdue));
    }
    const c = custOf(biz, seg[1]);
    if (!c) throw new ApiError(404, 'customer not found');
    const s = custStats(mb, c);
    const orders = biz.orders.filter((o) => o.customer_id === c.id).map((o) => liveOrder(mb, o)).sort((a, b) => a.days_ago - b.days_ago);
    const ovd = s.ch[0];
    const invs = biz.invoices.filter((i) => i.customer_id === c.id && !i.paid && i.due_days_ago > 0).sort((a, b) => b.due_days_ago - a.due_days_ago);
    const main = invs[0];
    const followups: CustomerDetail['followups'] = main ? main.followups.map((f) => ({ at: new Date(Date.now() - f.days_ago * DAY).toISOString(), kind: f.kind, text: f.text, status: f.status })) : [];
    if (main) {
      const caseRef = biz.reminderCase[main.number];
      const apr = caseRef ? (Object.values(mb.db.approvals) as Approval[]).find((a) => a.case_id === caseRef && (a.status === 'pending' || a.status === 'partially_approved')) : null;
      if (apr) followups.push({ at: new Date(Date.now() + 7 * DAY).toISOString(), kind: `Reminder ${main.followups.length + 1}${main.due_days_ago >= 30 ? ', firmer tone' : ''}`, text: 'Drafted · needs your OK before it goes', status: 'draft', draft: mb.db.cases[caseRef].proposal?.action.message ?? null, approval_id: apr.id });
    }
    const nbRow = s.rows[0];
    return {
      customer: { id: c.id, name: c.name, gstin: c.gstin, city: c.city, outstanding: s.outstanding, overdue: s.overdue, avg_days_to_pay: c.avg_days, terms_days: c.terms_days, risk: s.risk, risk_reason: s.risk_reason, contact_masked: `+91 ${c.phone.slice(0, 2)}••• ••${c.phone.slice(-3)}`, contact_name: c.contact_name, since: c.since, not_billed: s.not_billed },
      stats: { not_billed: s.not_billed, overdue: s.overdue, avg_days_to_pay: c.avg_days, terms_days: c.terms_days, risk: s.risk, risk_reason: s.risk_reason, not_billed_note: nbRow ? `${nbRow.po_ref} · ${s.rows.length > 1 ? `+${s.rows.length - 1} more` : `${liveOrder(mb, biz.orders.find((o) => o.case_ref === nbRow.case_ref)!).delivered - liveOrder(mb, biz.orders.find((o) => o.case_ref === nbRow.case_ref)!).billed} units`}` : 'nothing waiting', overdue_note: ovd ? `${ovd.invoice_number} · ${ovd.days_late} days` : 'nothing overdue' },
      orders: orders.map((o) => {
        const inv = biz.invoices.find((i) => i.po_ref === o.po_ref);
        const status = o.open_approval ? (o.open_approval.required_approvers > 1 && o.open_approval.approvers.length ? 'Awaiting 2nd approval' : `Bill ${rs((o.delivered - o.billed) * o.rate)}`) : o.delivered > o.billed ? `Bill ${rs((o.delivered - o.billed) * o.rate)}` : inv && !inv.paid && inv.due_days_ago > 0 ? `Overdue ${inv.due_days_ago} days` : o.paid >= o.billed && o.billed > 0 ? 'Closed' : o.delivered === 0 ? 'Not delivered' : o.billed > 0 ? 'Billed' : 'Open';
        return { po_ref: o.po_ref, case_ref: o.case_ref, item: o.item, date: new Date(Date.now() - o.days_ago * DAY).toISOString(), ordered: o.ordered, delivered: o.delivered, billed: o.billed, paid: Math.round(o.paid), amount: o.ordered * o.rate, status };
      }),
      followups,
    } as CustomerDetail;
  }

  if (seg[0] === 'unlinked') {
    if (seg.length === 1) return { items: clone(biz.unlinked), sorted: clone(biz.sorted) };
    const it = biz.unlinked.find((x) => x.id === seg[1]);
    if (!it) throw new ApiError(404, 'already sorted');
    if (seg[2] === 'ignore') {
      biz.unlinked = biz.unlinked.filter((x) => x !== it);
      biz.sorted.unshift({ at: mb.now(), text: `${it.source.label} from ${it.from.replace(/\s*\(.*\)/, '')}`, outcome: `ignored by ${userName(me.email)} · not about an order` });
      mb.auditRow({ actor: me.email, action: 'unlinked.ignore', detail: it.id });
      mb.emit({ type: 'case.updated', case_id: '', state: 'WATCHING' as any });
      return { ok: true };
    }
    if (seg[2] === 'link') {
      need(['operator', 'admin', 'finance_approver']);
      const ref = String(body?.case_ref ?? '');
      const d: CaseDetail = mb.db.cases[ref];
      if (!d) throw new ApiError(404, 'case not found');
      biz.unlinked = biz.unlinked.filter((x) => x !== it);
      const learned: string[] = [];
      if (it.extracted.customer && it.extracted.customer !== d.case.customer) { biz.aliases.push({ kind: 'customer', alias: it.extracted.customer, canonical: d.case.customer ?? '' }); learned.push(`"${it.extracted.customer}" = ${d.case.customer}`); }
      if (!it.from.includes('not in your contacts') && !/dispatch/i.test(it.from)) learned.push(`${it.from} sends deliveries`);
      biz.sorted.unshift({ at: mb.now(), text: `${it.source.label} from ${it.from.replace(/\s*\(.*\)/, '')} → ${d.case.reference}`, outcome: `attached by ${userName(me.email)}${learned.length ? ' · we\'ll remember ' + learned.join(', ') : ''}` });
      const nodeId = `ev_link_${it.id}`;
      const open = (Object.values(mb.db.approvals) as Approval[]).some((a) => a.case_id === ref && (a.status === 'pending' || a.status === 'partially_approved'));
      const qty = it.extracted.qty ?? 0;
      const material = !open && qty > 0 && (d.facts?.delivered_qty ?? 0) === 0;
      mb.addNode(ref, { id: nodeId, kind: it.source.kind === 'voice' ? 'voice_note' : 'photo', source: 'media', source_id: `wa:${it.id}`, ts: it.received_at, title: `${it.source.label} from ${it.from.replace(/\s*\(.*\)/, '')}`, excerpt: it.preview, fields: { qty, linked_by: me.email } }, [], material);
      mb.auditRow({ case_id: ref, actor: me.email, action: 'unlinked.link', detail: `${it.id} → ${ref}${learned.length ? ' · alias learned: ' + learned.join(', ') : ''}` });
      if (material) await correctFact(mb, ref, 'delivered', String(qty), `From linked ${it.source.label.toLowerCase()}`, me);
      else mb.touch(ref);
      return { ok: true };
    }
  }
  if (path === '/aliases') return { items: clone(biz.aliases) };

  if (path === '/reports/summary' || path === '/reports/export') {
    const invs = biz.invoices;
    const billed = flowFor(mb, 'month').billed;
    const collected = flowFor(mb, 'month').paid;
    const rows = toBillRows(mb);
    const ag: Record<'0-7' | '8-30' | '31-60' | '60+', number> = { '0-7': 0, '8-30': 0, '31-60': 0, '60+': 0 };
    rows.forEach((r) => { const k = r.waiting_days <= 7 ? '0-7' : r.waiting_days <= 30 ? '8-30' : r.waiting_days <= 60 ? '31-60' : '60+'; ag[k] += r.amount; });
    const rec: Record<string, number> = { '0–30 days': 0, '31–60': 0, '61–90': 0, '90+': 0 };
    invs.filter((i) => !i.paid && i.due_days_ago > 0).forEach((i) => { const d = i.due_days_ago; rec[d <= 30 ? '0–30 days' : d <= 60 ? '31–60' : d <= 90 ? '61–90' : '90+'] += i.amount; });
    if (path === '/reports/export') {
      const head = 'Invoice,Date,Customer,Customer GSTIN,Place of supply,PO,Taxable value,CGST,SGST,IGST,Total,Status';
      const lines = invs.map((i) => {
        const c = custOf(biz, i.customer_id)!;
        const taxable = Math.round(i.amount / 1.18);
        const tax = i.amount - taxable;
        const same = c.state_code === biz.settings.company.state_code;
        const date = new Date(Date.now() - i.issued_days_ago * DAY).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
        return [i.number, date, `"${c.name}"`, c.gstin, `${c.state_code}-${STATE_NAMES[c.state_code] ?? ''}`, i.po_ref, taxable, same ? (tax / 2).toFixed(2) : '0.00', same ? (tax / 2).toFixed(2) : '0.00', same ? '0.00' : tax.toFixed(2), i.amount, i.paid ? 'Paid' : i.due_days_ago > 0 ? `Overdue ${i.due_days_ago}d` : 'Not due'].join(',');
      });
      const unb = rows.map((r) => [`(not billed)`, '', `"${r.customer}"`, custOf(biz, r.customer_id)?.gstin, '', r.po_ref, r.amount, '', '', '', '', `Delivered, not billed · ${r.waiting_days}d · proof: ${r.proofs.map((p) => p.label).join(' / ')}`].join(','));
      return [head, ...lines, ...unb].join('\n') + '\n';
    }
    const gst = invs.filter((i) => i.issued_days_ago <= 31).reduce((s, i) => s + (i.amount - Math.round(i.amount / 1.18)), 0);
    return {
      recovered_by_month: [{ month: 'Jul 2026', amount: 92000 }, { month: 'Aug 2026', amount: 141500 }, { month: 'Sep 2026', amount: biz.recovered.last_month }, { month: 'Oct 2026', amount: biz.recovered.base + biz.recovered.extra }],
      unbilled_ageing: ag, collections: { billed, collected, rate: billed ? +(collected / billed).toFixed(3) : 0 }, receivables_ageing: rec,
      billed_count: invs.filter((i) => i.issued_days_ago <= 31).length + 8, gst_total: Math.round(gst + 0.18 * billed * 0.6), payments: 11, caught: biz.recovered.base + biz.recovered.extra, caught_count: biz.recovered.invoices + biz.recovered.extra_count + 4,
      still_open: rows.reduce((s, r) => s + r.amount, 0) + chaseRows(mb).reduce((s, r) => s + r.amount, 0),
    };
  }

  if (path === '/settings') {
    if (method === 'PUT') {
      need(['admin']);
      const b = body ?? {};
      biz.settings = { ...biz.settings, ...b, company: { ...biz.settings.company, ...(b.company ?? {}) }, digest: { ...biz.settings.digest, ...(b.digest ?? {}) } };
      mb.auditRow({ actor: me.email, action: 'settings.update', detail: Object.keys(b).join(', ') });
    }
    return clone(biz.settings);
  }
  if (path === '/settings/team') return { items: clone(biz.team) };
  if (path === '/settings/notifications' && method === 'PUT') { biz.settings.notifications = { ...biz.settings.notifications!, ...body }; mb.auditRow({ actor: me.email, action: 'settings.notifications', detail: JSON.stringify(body) }); return { ok: true }; }
  if (path === '/me/phone' && method === 'PUT') {
    const m = biz.team.find((t) => t.email === me.email);
    const d = String(body?.phone ?? '').replace(/\D/g, '');
    if (d.length < 10) throw new ApiError(400, 'Please enter a 10-digit mobile number.');
    if (m) m.phone_masked = `+91 ${d.slice(-10, -8)}••• ••${d.slice(-3)}`;
    mb.auditRow({ actor: me.email, action: 'me.phone', detail: 'approver phone linked' });
    return { ok: true, phone_masked: m?.phone_masked };
  }

  if (seg[0] === 'connectors' && seg[1] === 'whatsapp' && seg[2] === 'chats') {
    if (method === 'PUT') {
      need(['admin']);
      const w = new Set<string>(body?.watched ?? []);
      biz.chats.forEach((c) => { c.watched = w.has(c.jid); });
      mb.auditRow({ actor: me.email, action: 'whatsapp.allowlist', detail: `${w.size} chats watched · others dropped before storage` });
      return { ok: true };
    }
    return { items: clone(biz.chats) };
  }
  if (path === '/connectors/sheets/files') {
    return { files: [{ id: '1YqDispatchRegister2026', name: 'Dispatch Register 2026', modified_at: new Date().toISOString() }, { id: '1YqPartyLedger2026', name: 'Party ledger 2026-27', modified_at: new Date(Date.now() - 2 * 864e5).toISOString() }] };
  }
  if (path === '/connectors/sheets/tabs') {
    const head = ['PO No.', 'Party', 'Item', 'Qty', 'Disp Qty', 'Bal', 'Dt', 'Driver'];
    return { sheet_id: params.get('sheet_id'), title: params.get('sheet_id') === '1YqPartyLedger2026' ? 'Party ledger 2026-27' : 'Dispatch Register 2026', suggested: 'Oct',
      tabs: [{ title: 'Sep', rows: 180, header: head, score: 5 }, { title: 'Oct', rows: 214, header: head, score: 5 }, { title: 'Notes', rows: 12, header: ['Note'], score: 0 }] };
  }
  if (path === '/connectors/sheets/config' && method === 'GET') {
    const cfg = mb.db.connectors.sheets?.config ?? {};
    const rng = String(cfg.range ?? '');
    return { spreadsheet_id: cfg.spreadsheet_id ?? null, title: cfg.title ?? (cfg.spreadsheet_id ? 'Dispatch Register 2026' : null), tab: cfg.tab ?? (rng.includes('!') ? rng.split('!')[0] : null), mapping: cfg.mapping ?? {}, saved_by: cfg.saved_by ?? null, saved_at: cfg.saved_at ?? null };
  }
  if (path === '/connectors/sheets/propose-mapping') {
    return {
      title: 'Dispatch Register 2026', tab: body?.tab ?? 'Oct', rows: 214,
      columns: [
        { header: 'PO No.', meaning: 'po_ref', confidence: 'sure', sample: 'PO-184, PO-185, PO 176' },
        { header: 'Party', meaning: 'customer', confidence: 'sure', sample: 'Example Customer, Kaveri…' },
        { header: 'Item', meaning: 'item', confidence: 'sure', sample: 'Model X, Model Y' },
        { header: 'Qty', meaning: 'qty_ordered', confidence: 'sure', sample: '100, 200, 55' },
        { header: 'Disp Qty', meaning: 'qty_delivered', confidence: 'check', sample: '70, 200, 55' },
        { header: 'Bal', meaning: 'qty_pending', confidence: 'sure', sample: '30, 0, 0' },
        { header: 'Dt', meaning: 'delivery_date', confidence: 'check', sample: '14/10/26, 13/10/26' },
        { header: 'Driver', meaning: 'ignore', confidence: 'sure', sample: 'Raju, Imran' },
      ],
    };
  }
  if (path === '/setup/backfill') {
    if (method === 'POST') { biz.backfillStart = Date.now(); mb.auditRow({ actor: me.email, action: 'setup.backfill', detail: `${body?.days ?? 90} days` }); return { job_id: 'bf_' + Date.now().toString(36) }; }
    const t = biz.backfillStart ? (Date.now() - biz.backfillStart) / 1000 : 0;
    const p = (start: number, len: number) => (biz.backfillStart ? Math.max(0, Math.min(1, (t - start) / len)) : 0);
    const S = [
      { name: 'Gmail', total: 412, start: 0, len: 4, label: (n: number) => `Read ${n} emails, found ${Math.round(n * 63 / 412)} purchase orders` },
      { name: 'WhatsApp', total: 1180, start: 1, len: 5, label: (n: number) => `Read ${n.toLocaleString('en-IN')} WhatsApp messages from ${biz.chats.filter((c) => c.watched).length} chats: ${Math.round(n * 74 / 1180)} challans, ${Math.round(n * 21 / 1180)} voice notes` },
      { name: 'Sheet', total: 214, start: 3, len: 3, label: (n: number) => `Matched ${n} sheet rows to orders` },
      { name: 'Zoho Books', total: 188, start: 5, len: 3, label: (n: number) => `Compared with ${n} invoices in Zoho` },
    ];
    const sources = S.map((s) => { const k = p(s.start, s.len); const done = Math.round(s.total * k); return { name: s.name, done, total: s.total, status: !biz.backfillStart ? 'waiting' : k >= 1 ? 'done' : k > 0 ? 'running' : 'waiting', label: s.label(done) }; });
    const all = sources.every((s) => s.status === 'done');
    const rows = toBillRows(mb);
    return { sources, first_case_ref: all ? MAIN_CASE : null, found_amount: all ? rows.reduce((s, r) => s + r.amount, 0) : 0, found_count: all ? rows.length : 0 };
  }
  if (path === '/ask' && method === 'POST') return ask(mb, String(body?.question ?? ''), body?.lang);
  return NO;
}

/** Connector list with v2 health fields. */
export function connectorsV2(mb: any) {
  return Object.values(mb.db.connectors).map((c: any) => ({
    ...c,
    health: c.status === 'connected' ? 'ok' : c.status === 'degraded' || c.status === 'error' ? 'down' : c.status === 'pairing' ? 'relogin' : undefined,
    error_plain: c.status === 'degraded' ? `${c.name === 'zoho' ? 'Zoho Books' : c.name} is not answering. We pause and retry; nothing is billed twice.` : c.status === 'disconnected' ? 'Not connected yet.' : null,
  }));
}
