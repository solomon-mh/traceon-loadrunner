/**
 * Hard cap on in-flight requests. A scheduler tick that finds no free slot
 * simply doesn't get one — callers must NOT queue the rejected attempt for
 * later, which is what turns "target rate the backend can't sustain" into
 * an honestly-reported lower actual rate instead of an unbounded promise
 * pileup.
 */
export class ConcurrencyPool {
  private active = 0;
  private peak = 0;

  constructor(private readonly max: number) {}

  get activeCount(): number {
    return this.active;
  }

  get peakCount(): number {
    return this.peak;
  }

  tryAcquire(): boolean {
    if (this.active >= this.max) return false;
    this.active++;
    if (this.active > this.peak) this.peak = this.active;
    return true;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }
}
