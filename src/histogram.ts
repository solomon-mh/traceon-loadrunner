/**
 * Streaming latency histogram: fixed, bounded memory regardless of request
 * count — a 500 req/s test running for minutes must not accumulate a raw
 * per-request latency array just to compute percentiles at the end.
 *
 * Log-scaled buckets (~5% relative width, growth factor 1.05) trade a small,
 * fixed amount of percentile precision for O(1) recording and a single
 * small typed array (~260 buckets covering 0-5min) instead of unbounded
 * memory growth.
 */
const MAX_MS = 300_000; // 5 minutes — well past any sane request timeout
const GROWTH = 1.05;
const LOG_GROWTH = Math.log(GROWTH);

function bucketIndex(ms: number): number {
  if (ms <= 0) return 0;
  const clamped = Math.min(ms, MAX_MS);
  return Math.floor(Math.log(clamped) / LOG_GROWTH);
}

function bucketUpperBound(index: number): number {
  return Math.pow(GROWTH, index + 1);
}

const BUCKET_COUNT = bucketIndex(MAX_MS) + 2;

export class LatencyHistogram {
  private counts = new Uint32Array(BUCKET_COUNT);
  private total = 0;
  private sum = 0;
  private maxSeen = 0;

  record(ms: number): void {
    const idx = bucketIndex(ms);
    this.counts[idx] = (this.counts[idx] ?? 0) + 1;
    this.total++;
    this.sum += ms;
    if (ms > this.maxSeen) this.maxSeen = ms;
  }

  get count(): number {
    return this.total;
  }

  get mean(): number {
    return this.total > 0 ? this.sum / this.total : 0;
  }

  get max(): number {
    return this.maxSeen;
  }

  /** p in [0, 1]. Returns the upper bound of the bucket containing the
   * requested rank — within ~5% of the true value, never an underestimate. */
  percentile(p: number): number {
    if (this.total === 0) return 0;
    const target = Math.ceil(p * this.total);
    let cumulative = 0;
    for (let i = 0; i < this.counts.length; i++) {
      cumulative += this.counts[i] ?? 0;
      if (cumulative >= target) return bucketUpperBound(i);
    }
    return this.maxSeen;
  }
}
