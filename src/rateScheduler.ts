/**
 * Smooth request-rate scheduler: accrues fractional "allowed starts" at
 * high tick resolution instead of releasing a whole second's worth of
 * requests in one burst at each second boundary. Ramp-up is modeled as a
 * linearly increasing target rate from 0 to targetRps, sampled at each
 * tick's midpoint.
 */
export class RateScheduler {
  private accumulated = 0;
  private lastTickMs: number;
  private readonly startMs: number;

  constructor(
    private readonly targetRps: number,
    private readonly rampUpSeconds: number,
    nowMs: number = Date.now(),
  ) {
    this.startMs = nowMs;
    this.lastTickMs = nowMs;
  }

  private currentRate(atMs: number): number {
    if (this.rampUpSeconds <= 0) return this.targetRps;
    const elapsedSec = (atMs - this.startMs) / 1000;
    if (elapsedSec >= this.rampUpSeconds) return this.targetRps;
    if (elapsedSec <= 0) return 0;
    return this.targetRps * (elapsedSec / this.rampUpSeconds);
  }

  /** Call periodically (e.g. every ~25ms). Returns how many new requests
   * are allowed to start since the previous call — the fractional
   * remainder carries over, so slow or jittery ticks still converge on the
   * right long-run average instead of losing throughput to rounding. */
  tick(nowMs: number = Date.now()): number {
    const elapsedMs = nowMs - this.lastTickMs;
    if (elapsedMs <= 0) return 0;
    const rate = this.currentRate(this.lastTickMs + elapsedMs / 2);
    this.accumulated += (rate * elapsedMs) / 1000;
    this.lastTickMs = nowMs;
    const allowed = Math.floor(this.accumulated);
    this.accumulated -= allowed;
    return allowed;
  }
}
