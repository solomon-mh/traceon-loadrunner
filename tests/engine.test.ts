import { describe, it, expect, vi } from "vitest";
import { LoadTestEngine } from "../src/engine.js";
import type { LoadTestConfig } from "../src/protocol.js";

function fakeResponse(ok: boolean, status: number, bytes: number): Response {
  return { ok, status, arrayBuffer: async () => new ArrayBuffer(bytes) } as unknown as Response;
}

function baseConfig(overrides: Partial<LoadTestConfig> = {}): LoadTestConfig {
  return {
    targetUrl: "https://example.com",
    targetRps: 20,
    durationSeconds: 1,
    rampUpSeconds: 0,
    maxConcurrency: 10,
    ...overrides,
  };
}

describe("LoadTestEngine", () => {
  it("generates load at approximately the configured rate and reports it honestly", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(true, 200, 100)) as unknown as typeof fetch;
    const engine = new LoadTestEngine(baseConfig({ targetRps: 20, durationSeconds: 1 }), { fetchImpl });
    const result = await engine.start();

    expect(result.finalMetrics.totalRequests).toBeGreaterThan(10);
    expect(result.finalMetrics.totalRequests).toBeLessThan(30);
    expect(result.finalMetrics.failedRequests).toBe(0);
    expect(result.finalMetrics.errorRate).toBe(0);
    expect(result.activeLoadDurationMs).toBeCloseTo(1000, -2);
  }, 10000);

  it("caps actual concurrency at maxConcurrency and reports actualRps below targetRps when the target can't keep up", async () => {
    let inFlight = 0;
    let observedPeak = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight++;
      observedPeak = Math.max(observedPeak, inFlight);
      await new Promise((r) => setTimeout(r, 200)); // slow target
      inFlight--;
      return fakeResponse(true, 200, 100);
    }) as unknown as typeof fetch;

    // 100 req/s requested, but each request takes 200ms and only 5 slots
    // are allowed — physically caps throughput at 5 / 0.2s = 25 req/s.
    const engine = new LoadTestEngine(baseConfig({ targetRps: 100, maxConcurrency: 5, durationSeconds: 1 }), { fetchImpl });
    const result = await engine.start();

    expect(observedPeak).toBeLessThanOrEqual(5);
    expect(result.finalMetrics.peakConcurrency).toBeLessThanOrEqual(5);
    expect(result.finalMetrics.actualRps).toBeLessThan(result.finalMetrics.targetRps);
    expect(result.finalMetrics.actualRps).toBeGreaterThan(0);
  }, 10000);

  it("measures latency as response time, never test/wall-clock duration", async () => {
    const fetchImpl = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return fakeResponse(true, 200, 10);
    }) as unknown as typeof fetch;
    const engine = new LoadTestEngine(baseConfig({ targetRps: 5, durationSeconds: 1 }), { fetchImpl });
    const result = await engine.start();

    // Each request takes ~50ms — latency percentiles must reflect that, not
    // the ~1000ms+ total test duration.
    expect(result.finalMetrics.p50).toBeGreaterThan(30);
    expect(result.finalMetrics.p50).toBeLessThan(500);
    expect(result.finalMetrics.maxLatency).toBeLessThan(500);
  }, 10000);

  it("classifies non-ok responses and thrown errors as failures", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call % 2 === 0) return fakeResponse(false, 500, 0);
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    const engine = new LoadTestEngine(baseConfig({ targetRps: 20, durationSeconds: 1 }), { fetchImpl });
    const result = await engine.start();

    expect(result.finalMetrics.totalRequests).toBeGreaterThan(0);
    expect(result.finalMetrics.errorRate).toBe(1);
    expect(result.finalMetrics.lastError).toBeDefined();
  }, 10000);

  it("stops starting new requests immediately on stop() but lets in-flight ones finish", async () => {
    let started = 0;
    let finished = 0;
    const fetchImpl = vi.fn(async () => {
      started++;
      await new Promise((r) => setTimeout(r, 300));
      finished++;
      return fakeResponse(true, 200, 10);
    }) as unknown as typeof fetch;

    const engine = new LoadTestEngine(baseConfig({ targetRps: 10, durationSeconds: 10, maxConcurrency: 10 }), { fetchImpl });
    const runPromise = engine.start();

    await new Promise((r) => setTimeout(r, 150)); // let a few requests start
    const startedBeforeStop = started;
    engine.stop();
    await new Promise((r) => setTimeout(r, 50));
    const startedShortlyAfterStop = started;

    const result = await runPromise;

    // No meaningful growth in "started" after stop() (a tick or two of
    // in-flight overlap is fine — a runaway spin is not).
    expect(startedShortlyAfterStop - startedBeforeStop).toBeLessThan(5);
    expect(finished).toBe(started); // every started request was allowed to finish
    expect(result.finalMetrics.totalRequests).toBe(started);
  }, 10000);

  it("emits periodic live metrics while running", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(true, 200, 10)) as unknown as typeof fetch;
    const engine = new LoadTestEngine(baseConfig({ targetRps: 20, durationSeconds: 1 }), { fetchImpl });
    const seen: number[] = [];
    const unsubscribe = engine.onMetrics((m) => seen.push(m.totalRequests));

    await engine.start();
    unsubscribe();

    expect(seen.length).toBeGreaterThan(0);
  }, 10000);
});
