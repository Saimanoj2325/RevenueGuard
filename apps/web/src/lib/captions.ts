// Deterministic caption map: socket events / tool names -> plain sentences for the Live feed.
// No LLM-written captions, ever.
import type { WsEvent } from './types';

export type FeedTone = 'ink' | 'red' | 'amber' | 'green';
export interface FeedLine {
  id: string;
  ts: number;
  case_id: string | null;
  source: string; // small uppercase label
  text: string;
  tone: FeedTone;
}

/** tool name -> [source label, sentence] */
export const TOOL_CAPTIONS: Record<string, [string, string]> = {
  gmail_search: ['Intake', 'Looking in Gmail for the PO'],
  whatsapp_search: ['Intake', 'Checking WhatsApp for delivery updates'],
  search_alt_ids: ['Checking Zoho', 'Checking if it was billed under another reference'],
  compute_billable: ['Checking', 'Working out the exact amount to bill'],
  extract_fields: ['Reading photo', 'Reading the PO, customer and quantity'],
  laya_decide: ['Intake', 'Sorting the new message'],
  case_attach_or_open: ['Matching', 'Matching it to the right order'],
  zoho_get_salesorders: ['Checking Zoho', 'Finding the sales order in Zoho'],
  zoho_get_invoices: ['Checking Zoho', 'Looking for an invoice in Zoho'],
  sheets_read_delivery: ['Matching', 'Reading the delivery sheet'],
  read_delivery_sheet: ['Matching', 'Reading the delivery sheet'],
  search_credit_notes: ['Checking Zoho', 'Checking credit notes'],
  bank_get_payments: ['Checking', 'Checking the bank statement for a payment'],
  get_billing_rules: ['Checking', 'Reading your billing rules'],
  compare_counts: ['Checking', 'Comparing the counts from each source'],
  draft_action: ['Invoice', 'Drafting the invoice'],
  draft_invoice: ['Invoice', 'Drafting the invoice'],
  risk_score: ['Checking', 'Checking how sure we are'],
  transcribe: ['Voice note', 'Listening to the voice note'],
  vision_read: ['Reading photo', 'Reading the photo'],
};

/** case state -> [source, sentence, tone] */
export const STATE_CAPTIONS: Record<string, [string, string, FeedTone]> = {
  INTAKE: ['Intake', 'New message received', 'ink'],
  TRIAGED: ['Intake', 'Read and sorted', 'ink'],
  WATCHING: ['Matching', 'Matched to an order. Waiting for delivery proof', 'ink'],
  EVIDENCE_READY: ['Matching', 'Order and delivery proof found', 'ink'],
  VALIDATED: ['Checking', 'Amount worked out from the proof', 'ink'],
  INVESTIGATING: ['Checking Zoho', 'Making sure it is really not billed', 'ink'],
  PROPOSED: ['Invoice', 'Invoice drafted', 'ink'],
  AWAITING_APPROVAL: ['Waiting for you', 'Waiting for your approval', 'amber'],
  EXECUTING: ['Invoice', 'Creating the invoice in Zoho', 'ink'],
  VERIFYING: ['Verified', 'Reading the invoice back from Zoho', 'ink'],
  CLOSED: ['Verified', 'Done. Checked in Zoho', 'green'],
  PAUSED: ['Problem', 'Paused. We will retry by ourselves', 'amber'],
  ESCALATED: ['Problem', 'Needs a person to look at it', 'red'],
  BLOCKED: ['Problem', 'Stopped by a safety check', 'red'],
};

export const GUARD_CAPTIONS: Record<string, [string, FeedTone]> = {
  injection: ['Suspicious email kept aside. It cannot change anything', 'red'],
  role_block: ['Someone without approval rights tried to approve. Blocked', 'amber'],
  duplicate_block: ['Second invoice blocked. Nothing is billed twice', 'green'],
  approval_expired: ['Count changed, so the old approval was cancelled', 'amber'],
  paused: ['Paused safely. Will resume from the last step', 'amber'],
  resumed: ['Resumed from the last step. Nothing repeated', 'green'],
  fallback: ['Main AI service slow. Switched to backup', 'ink'],
  escalated: ['Sent to a person to check', 'red'],
  kill_switch: ['Writes stopped by the owner', 'amber'],
  validator_block: ['Edited amount did not match the proof. Not allowed', 'red'],
};

let n = 0;
const lid = () => `f${Date.now().toString(36)}${(n++).toString(36)}`;

/** Build a plain feed line from a socket event, or null when the event is not worth a line. */
export function captionFor(e: WsEvent & { _ts?: number }): FeedLine | null {
  const ts = e._ts ?? Date.now();
  switch (e.type) {
    case 'agent.event': {
      const ev = e.event;
      if (ev.type !== 'tool_call' && ev.type !== 'tool_result') return null;
      const tool = String(ev.data?.tool ?? '');
      const m = TOOL_CAPTIONS[tool];
      if (!m) return null;
      if (ev.type === 'tool_call') return { id: lid(), ts, case_id: e.case_id, source: m[0], text: m[1], tone: 'ink' };
      // results: a line only when the tool returned a structured fact (templated, never model prose)
      const f = foundLine(ev.data?.found);
      return f ? { id: lid(), ts, case_id: e.case_id, ...f } : null;
    }
    case 'checkpoint':
      return null; // case.updated already carries the state change
    case 'case.updated': {
      const m = STATE_CAPTIONS[e.state];
      if (!m) return null;
      return { id: lid(), ts, case_id: e.case_id, source: m[0], text: m[1], tone: m[2] };
    }
    case 'approval.updated': {
      const a = e.approval;
      const amt = a.amount ? ' ₹' + Math.round(a.amount).toLocaleString('en-IN') : '';
      if (a.status === 'pending') return { id: lid(), ts, case_id: a.case_id, source: 'Waiting for you', text: `Approval needed for${amt || ' an invoice'}`, tone: 'amber' };
      if (a.status === 'partially_approved') return { id: lid(), ts, case_id: a.case_id, source: 'Waiting for you', text: `1 of ${a.required_approvers} approvals done for${amt}`, tone: 'amber' };
      if (a.status === 'approved') {
        const who = a.approvers.at(-1)?.email?.split('@')[0] ?? 'Finance';
        return { id: lid(), ts, case_id: a.case_id, source: cap(who), text: `Approved${amt}`, tone: 'green' };
      }
      if (a.status === 'expired') return { id: lid(), ts, case_id: a.case_id, source: 'Check', text: `Old${amt} approval cancelled: the proof changed`, tone: 'amber' };
      if (a.status === 'rejected') return { id: lid(), ts, case_id: a.case_id, source: 'Check', text: `Rejected${amt}`, tone: 'red' };
      return null;
    }
    case 'guardrail': {
      const g = GUARD_CAPTIONS[e.kind];
      if (!g) return null;
      return { id: lid(), ts, case_id: e.case_id || null, source: 'Safety', text: g[0], tone: g[1] };
    }
    case 'connector.updated': {
      const name = CONNECTOR_NAMES[e.name] ?? e.name;
      if (e.status === 'degraded' || e.status === 'error') return { id: lid(), ts, case_id: null, source: 'Connections', text: `${name} is not answering. We will retry`, tone: 'amber' };
      if (e.status === 'connected') return { id: lid(), ts, case_id: null, source: 'Connections', text: `${name} connected`, tone: 'ink' };
      return null;
    }
    default:
      return null;
  }
}

const rs = (n: unknown) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
/** Templates over structured tool results ({doc:'challan', number, qty, item, po} …). */
export function foundLine(f: any): { source: string; text: string; tone: FeedTone } | null {
  if (!f || typeof f !== 'object') return null;
  switch (f.doc) {
    case 'photo_in': return { source: 'Intake', text: `Photo received from ${f.from}`, tone: 'ink' };
    case 'challan': return { source: 'Reading photo', text: `Read challan ${f.number}: ${f.qty} × ${f.item}, ${f.po}`, tone: 'ink' };
    case 'voice': return { source: 'Voice note', text: `"${f.text}" → ${f.qty} sent, ${f.pending} pending`, tone: 'ink' };
    case 'match': return { source: 'Matching', text: `Matched to ${f.po} · ${f.customer}`, tone: 'ink' };
    case 'proof': return { source: 'Proof', text: `Found PO email (${f.qty} units, ${rs(f.amount)}) and dispatch sheet row`, tone: 'ink' };
    case 'no_invoice': return { source: 'Checking Zoho', text: `No invoice in Zoho for ${f.po}. Also searched other references`, tone: 'red' };
    case 'correction': return { source: 'Intake', text: `Correction from ${f.from}: ${f.qty} delivered, not ${f.was}`, tone: 'amber' };
    case 'draft': return { source: 'Invoice', text: `Draft invoice: ${f.qty} × ${rs(f.rate)} + ${f.gst_rate ?? 18}% GST = ${rs(f.total)}`, tone: 'ink' };
    case 'invoice': return { source: 'Invoice', text: `Invoice ${f.number} created in Zoho Books`, tone: 'ink' };
    case 'verified': return { source: 'Verified', text: `Read back from Zoho: ${rs(f.total)} matches`, tone: 'green' };
    case 'recovered': return { source: 'RevenueGuard', text: `Recovered ${rs(f.total)} that was not billed`, tone: 'green' };
    default: return null;
  }
}

export const CONNECTOR_NAMES: Record<string, string> = { google: 'Gmail', gmail: 'Gmail', whatsapp: 'WhatsApp', sheets: 'Delivery sheet', zoho: 'Zoho Books', tally: 'Tally', bank: 'Bank statement', drive: 'Drive' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
