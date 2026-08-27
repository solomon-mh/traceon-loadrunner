import { RateScheduler } from "./rateScheduler.js";
import { ConcurrencyPool } from "./concurrencyPool.js";
import { LatencyHistogram } from "./histogram.js";
import type {
  LoadTestConfig,
  LoadMetrics,
  LoadTestResult,
  LoadTestTimeseriesPoint,
} from "./protocol.js";

const TICK_MS = 25;
const METRICS_INTERVAL_MS = 500;
const BUCKET_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

/** Node's fetch (undici) wraps every network failure — DNS, connection
 * refused, TLS, etc. — in a generic `TypeError: fetch failed`, with the
 * actually useful detail (e.g. "connect ECONNREFUSED 127.0.0.1:34567")
 * nested one level down in `.cause`. Surfacing only `err.message` reports
 * every distinct failure as the same uninformative "fetch failed" string;
 * `lastError` needs to say WHY. Timeouts (AbortSignal.timeout) are already
 * descriptive on their own and have no `.cause`, so this only adds detail
 * when there's more to add. */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) {
    return `${err.message}: ${cause.message}`;
  }
  return err.message;
}

function approxRequestBytes(config: LoadTestConfig): number {
  const headerBytes = config.headers
    ? new TextEncoder().encode(JSON.stringify(config.headers)).length
    : 0;
  const bodyBytes = config.body
    ? new TextEncoder().encode(config.body).length
    : 0;
  return headerBytes + bodyBytes;
}

interface Counters {
  total: number;
  successful: number;
  failed: number;
  bytesReceived: number;
  bytesSent: number;
  lastError?: string;
  lastErrorStatus?: number;
}

/**
 * Owns one load-test run end to end: the rate scheduler, the concurrency
 * pool, real HTTP requests, and metrics aggregation. Runs inside the
 * standalone Node process (see host.ts) — never inside the Chrome
 * extension, which is the entire point of this package.
 */
export class LoadTestEngine {
  private readonly config: LoadTestConfig;
  private readonly testStart: number;
  private readonly loadEndTime: number;
  private readonly scheduler: RateScheduler;
  private readonly pool: ConcurrencyPool;
  private readonly histogram = new LatencyHistogram();
  private readonly counters: Counters = {
    total: 0,
    successful: 0,
    failed: 0,
    bytesReceived: 0,
    bytesSent: 0,
  };
  private readonly inFlight = new Set<Promise<void>>();

  // Per-second timeseries: only the CURRENT second's histogram/counters are
  // held at once, rolled into a point and reset every ~1s — bounded by test
  // duration in seconds, not by request count (see BUCKET_MS timer below).
  private bucketHistogram = new LatencyHistogram();
  private bucketCount = 0;
  private bucketFailed = 0;
  private bucketBytes = 0;
  private readonly timeseries: LoadTestTimeseriesPoint[] = [];

  private stopped = false;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private metricsTimer: ReturnType<typeof setInterval> | undefined;
  private bucketTimer: ReturnType<typeof setInterval> | undefined;
  private metricsListeners = new Set<(metrics: LoadMetrics) => void>();
  private doneResolvers: (() => void)[] = [];
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: LoadTestConfig,
    options: { now?: number; fetchImpl?: typeof fetch } = {},
  ) {
    const now = options.now ?? Date.now();
    this.config = config;
    this.testStart = now;
    // Ramp-up is additive, not overlapping: request generation only stops
    // at rampUp+duration, so the configured duration is never silently
    // eaten into by ramp-up (same fix applied to the extension's earlier
    // in-process runner).
    this.loadEndTime =
      now + (config.rampUpSeconds + config.durationSeconds) * 1000;
    this.scheduler = new RateScheduler(
      config.targetRps,
      config.rampUpSeconds,
      now,
    );
    this.pool = new ConcurrencyPool(Math.max(1, config.maxConcurrency));
    // Injected for testability (same pattern as the extension's own
    // in-process runner's hooks.fetchImpl) — defaults to Node's global
    // fetch (undici), which is what host.ts actually runs with.
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  onMetrics(callback: (metrics: LoadMetrics) => void): () => void {
    this.metricsListeners.add(callback);
    return () => this.metricsListeners.delete(callback);
  }

  start(): Promise<LoadTestResult> {
    const donePromise = new Promise<void>((resolve) =>
      this.doneResolvers.push(resolve),
    );

    this.tickTimer = setInterval(() => this.onTick(), TICK_MS);
    this.metricsTimer = setInterval(
      () => this.emitMetrics(),
      METRICS_INTERVAL_MS,
    );
    this.bucketTimer = setInterval(() => this.rollBucket(), BUCKET_MS);

    return donePromise.then(() => this.finish());
  }

  /** Stop generating new requests immediately; in-flight requests are left
   * to finish naturally (graceful shutdown), never aborted mid-request. */
  stop(): void {
    this.stopped = true;
  }

  private onTick(): void {
    const now = Date.now();
    if (this.stopped || now >= this.loadEndTime) {
      this.stopTicking();
      return;
    }

    const allowed = this.scheduler.tick(now);
    for (let i = 0; i < allowed; i++) {
      if (!this.pool.tryAcquire()) break; // dropped, not queued — see ConcurrencyPool
      const p = this.performRequest().finally(() => {
        this.pool.release();
        this.inFlight.delete(p);
      });
      this.inFlight.add(p);
    }
  }

  private stopTicking(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    void this.awaitInFlightThenDone();
  }

  private async awaitInFlightThenDone(): Promise<void> {
    // Snapshot-and-wait, not a single Promise.all up front: performRequest
    // adds new entries to `inFlight` for the very brief moment between
    // scheduler.tick() firing and this shutdown path running, and any
    // still-outstanding promise settling removes itself — waiting on
    // repeated snapshots until the set drains catches all of them.
    while (this.inFlight.size > 0) {
      await Promise.race([...this.inFlight]);
    }
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.metricsTimer = undefined;
    if (this.bucketTimer) clearInterval(this.bucketTimer);
    this.bucketTimer = undefined;
    this.rollBucket(); // flush the last partial second
    for (const resolve of this.doneResolvers) resolve();
    this.doneResolvers = [];
  }

  private rollBucket(): void {
    const tSec = Math.floor((Date.now() - this.testStart) / 1000);
    this.timeseries.push({
      tSec,
      rps: this.bucketCount,
      p95: this.bucketHistogram.percentile(0.95),
      errorRate:
        this.bucketCount > 0 ? this.bucketFailed / this.bucketCount : 0,
      throughputBps: this.bucketBytes,
      activeConcurrency: this.pool.activeCount,
    });
    this.bucketHistogram = new LatencyHistogram();
    this.bucketCount = 0;
    this.bucketFailed = 0;
    this.bucketBytes = 0;
  }

  private async performRequest(): Promise<void> {
    const start = performance.now();
    try {
      const res = await this.fetchImpl(this.config.targetUrl, {
        method: this.config.method ?? "GET",
        ...(this.config.headers ? { headers: this.config.headers } : {}),
        ...(this.config.body !== undefined ? { body: this.config.body } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const buf = await res.arrayBuffer();
      const latencyMs = performance.now() - start;
      this.histogram.record(latencyMs);
      this.bucketHistogram.record(latencyMs);
      this.bucketCount++;
      this.bucketBytes += buf.byteLength;
      this.counters.total++;
      this.counters.bytesReceived += buf.byteLength;
      this.counters.bytesSent += approxRequestBytes(this.config);
      if (res.ok) {
        this.counters.successful++;
      } else {
        this.counters.failed++;
        this.bucketFailed++;
        this.counters.lastError = `HTTP ${res.status}`;
        this.counters.lastErrorStatus = res.status;
      }
    } catch (err) {
      const latencyMs = performance.now() - start;
      this.histogram.record(latencyMs);
      this.bucketHistogram.record(latencyMs);
      this.bucketCount++;
      this.bucketFailed++;
      this.counters.total++;
      this.counters.failed++;
      this.counters.lastError = describeFetchError(err);
      this.counters.bytesSent += approxRequestBytes(this.config);
    }
  }

  private buildMetrics(elapsedSeconds: number): LoadMetrics {
    const actualRps =
      elapsedSeconds > 0 ? this.counters.total / elapsedSeconds : 0;
    return {
      elapsedSeconds,
      targetRps: this.config.targetRps,
      actualRps,
      totalRequests: this.counters.total,
      successfulRequests: this.counters.successful,
      failedRequests: this.counters.failed,
      errorRate:
        this.counters.total > 0
          ? this.counters.failed / this.counters.total
          : 0,
      avgLatency: this.histogram.mean,
      p50: this.histogram.percentile(0.5),
      p90: this.histogram.percentile(0.9),
      p95: this.histogram.percentile(0.95),
      p99: this.histogram.percentile(0.99),
      maxLatency: this.histogram.max,
      bytesReceived: this.counters.bytesReceived,
      bytesSent: this.counters.bytesSent,
      activeConcurrency: this.pool.activeCount,
      peakConcurrency: this.pool.peakCount,
      ...(this.counters.lastError !== undefined
        ? { lastError: this.counters.lastError }
        : {}),
      ...(this.counters.lastErrorStatus !== undefined
        ? { lastErrorStatus: this.counters.lastErrorStatus }
        : {}),
    };
  }

  private emitMetrics(): void {
    const elapsedSeconds = (Date.now() - this.testStart) / 1000;
    const metrics = this.buildMetrics(elapsedSeconds);
    for (const listener of this.metricsListeners) listener(metrics);
  }

  private finish(): LoadTestResult {
    const testEnd = Date.now();
    const rampEndTime = this.testStart + this.config.rampUpSeconds * 1000;
    const generationEndTime = Math.min(testEnd, this.loadEndTime);

    // The post-ramp, full-rate window — equal to config.durationSeconds*1000
    // on a normal run (request generation only ever stops at loadEndTime),
    // shorter only if the run was stopped early. Same naming/semantics as
    // the extension's in-process runner's earlier duration fix.
    const activeLoadDurationMs = Math.max(0, generationEndTime - rampEndTime);
    const gracefulShutdownMs = Math.max(0, testEnd - this.loadEndTime);
    const durationMs = testEnd - this.testStart;

    // finalMetrics reports throughput over the FULL request-generation
    // window (ramp-up + active duration), not just activeLoadDurationMs —
    // unlike the old VU-based runner, ramp-up here is actively ramping
    // real traffic the whole time, so excluding it would understate
    // genuinely generated load.
    const fullWindowSec =
      Math.max(0, generationEndTime - this.testStart) / 1000;
    const finalMetrics = this.buildMetrics(fullWindowSec);

    return {
      config: this.config,
      startedAt: this.testStart,
      durationMs,
      activeLoadDurationMs,
      gracefulShutdownMs,
      finalMetrics,
      timeseries: this.timeseries,
    };
  }
}
