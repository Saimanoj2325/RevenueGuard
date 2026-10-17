import { describe, expect, it } from 'vitest';
import { captionFor, TOOL_CAPTIONS } from '../captions';
import { rupeesInWords, inr, dateIN, timeIN } from '../format';

describe('captions', () => {
  it('has the required deterministic tool sentences', () => {
    expect(TOOL_CAPTIONS.gmail_search[1]).toBe('Looking in Gmail for the PO');
    expect(TOOL_CAPTIONS.whatsapp_search[1]).toBe('Checking WhatsApp for delivery updates');
    expect(TOOL_CAPTIONS.search_alt_ids[1]).toBe('Checking if it was billed under another reference');
    expect(TOOL_CAPTIONS.compute_billable[1]).toBe('Working out the exact amount to bill');
  });
  it('captions a tool call and ignores unknown tools', () => {
    const ev = (tool: string) => ({ type: 'agent.event' as const, case_id: 'RG-1042', event: { run_id: 'r', case_id: 'RG-1042', type: 'tool_call' as const, agent: 'evidence' as const, data: { tool }, ts: '' } });
    expect(captionFor(ev('search_alt_ids'))?.text).toBe('Checking if it was billed under another reference');
    expect(captionFor(ev('secret_tool'))).toBeNull();
  });
  it('captions approval + guardrail events in plain words', () => {
    const a = { id: 'a', case_id: 'RG-1042', proposal_id: 'p', payload_hash: 'h', evidence_version: 1, status: 'expired' as const, required_approvers: 1, approvers: [], amount: 60000 };
    expect(captionFor({ type: 'approval.updated', approval: a })?.text).toBe('Old ₹60,000 approval cancelled: the proof changed');
    expect(captionFor({ type: 'guardrail', case_id: 'RG-1042', kind: 'injection', detail: '' })?.tone).toBe('red');
    expect(captionFor({ type: 'case.updated', case_id: 'RG-1042', state: 'AWAITING_APPROVAL' })?.source).toBe('Waiting for you');
  });
});

describe('Indian formats', () => {
  it('formats rupees in lakh style', () => { expect(inr(482000)).toBe('₹4,82,000'); expect(inr(10035000)).toBe('₹1,00,35,000'); });
  it('writes totals in words', () => {
    expect(rupeesInWords(82600)).toBe('Rupees Eighty Two Thousand Six Hundred Only');
    expect(rupeesInWords(236000)).toBe('Rupees Two Lakh Thirty Six Thousand Only');
  });
  it('dates and times in IST', () => {
    expect(dateIN('2026-10-15T10:00:00Z')).toBe('15 Oct 2026');
    expect(timeIN('2026-10-15T15:48:00Z')).toBe('9:18 PM');
  });
});
