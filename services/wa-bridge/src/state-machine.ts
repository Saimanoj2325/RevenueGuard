import type { ConnState } from './wa/types.js'

/**
 * Allowed connection transitions. Anything else is a bug and is logged + ignored.
 *   disconnected -> connecting
 *   connecting   -> qr | open | disconnected
 *   qr           -> qr (refresh) | connecting | open | disconnected
 *   open         -> connecting (reconnect) | disconnected
 */
const ALLOWED: Record<ConnState, ConnState[]> = {
  disconnected: ['connecting'],
  connecting: ['qr', 'open', 'disconnected', 'connecting'],
  qr: ['qr', 'connecting', 'open', 'disconnected'],
  open: ['connecting', 'disconnected'],
}

export class ConnectionStateMachine {
  private current: ConnState = 'disconnected'
  constructor(private readonly onChange: (from: ConnState, to: ConnState) => void = () => {}) {}

  get state(): ConnState {
    return this.current
  }

  canTransition(to: ConnState): boolean {
    return ALLOWED[this.current].includes(to)
  }

  /** Returns true if the transition happened. */
  transition(to: ConnState): boolean {
    if (!this.canTransition(to)) return false
    const from = this.current
    this.current = to
    if (from !== to || to === 'qr') this.onChange(from, to)
    return true
  }
}

/** Exponential backoff with full jitter, capped. attempt starts at 0. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, rand: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 20))
  return Math.round(exp / 2 + rand() * (exp / 2))
}
