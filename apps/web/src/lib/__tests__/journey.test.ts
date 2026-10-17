import { describe, expect, it } from 'vitest';
import { buildJourney, journeyProgress, JOURNEY_KEYS, STATE_TO_STEP, stepOf } from '../journey';
import { MAIN_STATES } from '../types';

const statuses = (s: Parameters<typeof buildJourney>[0]) => buildJourney(s).steps.map((x) => x.status);

describe('journey mapping', () => {
  it('maps every main backend state to a step', () => {
    for (const st of MAIN_STATES) expect(JOURNEY_KEYS).toContain(STATE_TO_STEP[st]);
  });
  it('INTAKE: received is current, rest not started', () => {
    expect(statuses({ state: 'INTAKE' })).toEqual(['current', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
  });
  it('TRIAGED reads, WATCHING matches, EVIDENCE_READY/VALIDATED/INVESTIGATING/PROPOSED check', () => {
    expect(stepOf('TRIAGED')).toBe('read');
    expect(stepOf('WATCHING')).toBe('matched');
    for (const s of ['EVIDENCE_READY', 'VALIDATED', 'INVESTIGATING', 'PROPOSED'] as const) expect(stepOf(s)).toBe('checked');
  });
  it('AWAITING_APPROVAL is amber "waiting" with who it waits for', () => {
    const j = buildJourney({ state: 'AWAITING_APPROVAL', waitingFor: 'Meera' });
    expect(j.current).toBe('waiting');
    expect(j.steps[4]).toMatchObject({ key: 'waiting', status: 'waiting', caption: 'waiting for Meera' });
    expect(j.steps.slice(0, 4).every((s) => s.status === 'done')).toBe(true);
  });
  it('EXECUTING / VERIFYING / CLOSED move through invoice, verify, paid', () => {
    expect(stepOf('EXECUTING')).toBe('invoiced');
    expect(stepOf('VERIFYING')).toBe('verified');
    expect(buildJourney({ state: 'CLOSED' }).steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done', 'current']);
    expect(statuses({ state: 'CLOSED', paid: true }).every((s) => s === 'done')).toBe(true);
  });
  it('PAUSED shows a red problem at the step it stopped on, with reason + next step', () => {
    const j = buildJourney({ state: 'PAUSED', prevState: 'EXECUTING', problem: { reason: 'Zoho is down.', next: "We'll retry at 9:45 PM. Nothing was billed twice." } });
    expect(j.current).toBe('invoiced');
    expect(j.steps[5].status).toBe('problem');
    expect(j.problem?.next).toContain('Nothing was billed twice');
  });
  it('ESCALATED / BLOCKED without history fall back to "checked" with a default reason', () => {
    for (const s of ['ESCALATED', 'BLOCKED'] as const) {
      const j = buildJourney({ state: s });
      expect(j.current).toBe('checked');
      expect(j.steps[3].status).toBe('problem');
      expect(j.problem?.reason).toBeTruthy();
    }
  });
  it('keeps times only on done steps and captions everywhere', () => {
    const j = buildJourney({ state: 'AWAITING_APPROVAL', at: { received: '2026-10-15T15:48:00Z', waiting: 'x' }, captions: { matched: 'PO-184' } });
    expect(j.steps[0].at).toBe('2026-10-15T15:48:00Z');
    expect(j.steps[4].at).toBeNull();
    expect(j.steps[2].caption).toBe('PO-184');
  });
  it('progress line grows to the current step', () => {
    expect(journeyProgress(buildJourney({ state: 'INTAKE' }))).toBe(0);
    expect(journeyProgress(buildJourney({ state: 'AWAITING_APPROVAL' }))).toBeCloseTo(4 / 7);
    expect(journeyProgress(buildJourney({ state: 'CLOSED', paid: true }))).toBe(1);
  });
});
