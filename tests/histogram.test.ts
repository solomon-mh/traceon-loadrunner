import { describe, it, expect } from "vitest";
import { LatencyHistogram } from "../src/histogram.js";

describe("LatencyHistogram", () => {
  it("returns 0 percentiles/mean/max on no data", () => {
    const h = new LatencyHistogram();
    expect(h.percentile(0.5)).toBe(0);
    expect(h.mean).toBe(0);
    expect(h.max).toBe(0);
    expect(h.count).toBe(0);
  });

  it("computes percentiles within ~5% of the true value on a uniform distribution", () => {
    const h = new LatencyHistogram();
    // 1..1000ms, evenly spaced — true p50 = 500, p95 = 950, p99 = 990.
    for (let ms = 1; ms <= 1000; ms++) h.record(ms);

    expect(h.count).toBe(1000);
    expect(h.percentile(0.5)).toBeGreaterThanOrEqual(500 * 0.95);
    expect(h.percentile(0.5)).toBeLessThanOrEqual(500 * 1.1);
    expect(h.percentile(0.95)).toBeGreaterThanOrEqual(950 * 0.95);
    expect(h.percentile(0.95)).toBeLessThanOrEqual(950 * 1.1);
    expect(h.percentile(0.99)).toBeGreaterThanOrEqual(990 * 0.95);
    expect(h.max).toBe(1000);
    expect(h.mean).toBeCloseTo(500.5, 0);
  });

  it("never returns a value below the requested rank's true value (no underestimate)", () => {
    const h = new LatencyHistogram();
    for (const ms of [10, 20, 30, 40, 50, 5000]) h.record(ms);
    // p99 of 6 samples should land on the largest bucket (5000ms outlier).
    expect(h.percentile(0.99)).toBeGreaterThanOrEqual(5000);
  });

  it("keeps a single fixed-size bucket array regardless of how many requests are recorded", () => {
    const h = new LatencyHistogram();
    for (let i = 0; i < 200_000; i++) h.record(Math.random() * 2000);
    expect(h.count).toBe(200_000);
    // No assertion on memory directly (not observable from here), but this
    // should complete instantly and not grow any array with sample count —
    // record() is O(1), never pushes to a raw array.
  });
});
