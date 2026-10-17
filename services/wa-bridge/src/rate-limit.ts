/** Token bucket (per-minute capacity) + minimum spacing between sends. */
export class SendRateLimiter {
  private tokens: number
  private last = Date.now()
  private lastSend = Number.NEGATIVE_INFINITY

  constructor(
    private readonly perMinute: number,
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = perMinute
    this.last = now()
  }

  /** Returns 0 if a send may proceed now (and consumes a token), else ms to wait. */
  tryAcquire(): number {
    const t = this.now()
    this.tokens = Math.min(this.perMinute, this.tokens + ((t - this.last) / 60_000) * this.perMinute)
    this.last = t
    const spacing = this.lastSend + this.minIntervalMs - t
    if (spacing > 0) return spacing
    if (this.tokens < 1) return Math.ceil(((1 - this.tokens) / this.perMinute) * 60_000)
    this.tokens -= 1
    this.lastSend = t
    return 0
  }
}
