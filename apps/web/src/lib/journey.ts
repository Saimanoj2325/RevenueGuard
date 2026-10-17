// ONE place that maps backend case states to the 8-step customer journey shown on the case page.
// Received > Read > Matched to PO > Checked > Waiting for you > Invoice created > Verified in Zoho > Paid
import type { CaseState } from './types';
import type { Journey, JourneyKey, JourneyStep, StepStatus } from './v2types';

export const JOURNEY_KEYS: JourneyKey[] = ['received', 'read', 'matched', 'checked', 'waiting', 'invoiced', 'verified', 'paid'];

export const JOURNEY_LABELS: Record<JourneyKey, string> = {
  received: 'Received', read: 'Read', matched: 'Matched to PO', checked: 'Checked', waiting: 'Waiting for you',
  invoiced: 'Invoice created', verified: 'Verified in Zoho', paid: 'Paid',
};

/** The step a case is ON while in a main state. */
export const STATE_TO_STEP: Record<Exclude<CaseState, 'PAUSED' | 'ESCALATED' | 'BLOCKED'>, JourneyKey> = {
  INTAKE: 'received',
  TRIAGED: 'read',
  WATCHING: 'matched',
  EVIDENCE_READY: 'checked',
  VALIDATED: 'checked',
  INVESTIGATING: 'checked',
  PROPOSED: 'checked',
  AWAITING_APPROVAL: 'waiting',
  EXECUTING: 'invoiced',
  VERIFYING: 'verified',
  CLOSED: 'paid',
};

const SIDE = new Set<CaseState>(['PAUSED', 'ESCALATED', 'BLOCKED']);

export interface JourneyInput {
  state: CaseState;
  /** for PAUSED / ESCALATED / BLOCKED: the main state the case was in (checkpoint resume_to / last main state) */
  prevState?: CaseState | null;
  /** payment received (only meaningful once CLOSED) */
  paid?: boolean;
  /** who the approval waits for, e.g. "Meera" */
  waitingFor?: string | null;
  /** plain-words reason + next step for a problem */
  problem?: { reason: string; next: string } | null;
  /** time each step finished (ISO) */
  at?: Partial<Record<JourneyKey, string | null>>;
  /** caption per step (e.g. "PO-184", "70 of 100", "INV-2231") */
  captions?: Partial<Record<JourneyKey, string | null>>;
}

export function stepOf(state: CaseState, prevState?: CaseState | null): JourneyKey {
  if (SIDE.has(state)) {
    if (prevState && !SIDE.has(prevState)) return STATE_TO_STEP[prevState as keyof typeof STATE_TO_STEP];
    return 'checked';
  }
  return STATE_TO_STEP[state as keyof typeof STATE_TO_STEP] ?? 'received';
}

export function defaultProblem(state: CaseState): { reason: string; next: string } | null {
  if (state === 'PAUSED') return { reason: 'Paused: a connection is down or the kill switch is on.', next: 'We will retry by ourselves. Nothing was billed twice.' };
  if (state === 'ESCALATED') return { reason: 'We could not finish this one safely.', next: 'A person needs to look at it. Open the case and check the proof.' };
  if (state === 'BLOCKED') return { reason: 'Blocked by a safety check.', next: 'Fix the reason shown below, then try again.' };
  return null;
}

export function buildJourney(input: JourneyInput): Journey {
  const { state, paid, at = {}, captions = {} } = input;
  const current = stepOf(state, input.prevState);
  const ci = JOURNEY_KEYS.indexOf(current);
  const isSide = SIDE.has(state);
  const problem = isSide ? input.problem ?? defaultProblem(state) : null;
  const allDone = state === 'CLOSED' && !!paid;

  const steps: JourneyStep[] = JOURNEY_KEYS.map((key, i) => {
    let status: StepStatus;
    if (allDone || i < ci) status = 'done';
    else if (i === ci) {
      if (isSide) status = 'problem';
      else if (key === 'waiting') status = 'waiting';
      else status = 'current';
    } else status = 'todo';
    let caption = captions[key] ?? null;
    if (status === 'waiting' && !caption) caption = input.waitingFor ? `waiting for ${input.waitingFor}` : 'waiting';
    if (status === 'problem' && problem && !caption) caption = problem.reason;
    return { key, status, at: status === 'done' ? at[key] ?? null : null, caption };
  });
  return { current, problem, steps };
}

/** Fraction (0..1) of the progress line to fill: up to the current step. */
export function journeyProgress(j: Journey): number {
  const ci = j.steps.findIndex((s) => s.status !== 'done');
  if (ci === -1) return 1;
  return ci / (JOURNEY_KEYS.length - 1);
}
