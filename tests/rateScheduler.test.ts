import { describe, it, expect } from "vitest";
import { RateScheduler } from "../src/rateScheduler.js";

describe("RateScheduler", () => {
  it("releases approximately targetRps tokens per second with no ramp-up", () => {
    const start = 0;
    const scheduler = new RateScheduler(100, 0, start);
    let total = 0;
    // Simulate 1 second of 25ms ticks.
    for (let t = 25; t <= 1000; t += 25) {
      total += scheduler.tick(start + t);
    }
    expect(total).toBeGreaterThanOrEqual(98);
    expect(total).toBeLessThanOrEqual(100);
  });

  it("never releases a burst — no single tick exceeds what a short interval should allow", () => {
    const start = 0;
    const scheduler = new RateScheduler(500, 0, start);
    const perTick: number[] = [];
    for (let t = 25; t <= 1000; t += 25) {
      perTick.push(scheduler.tick(start + t));
    }
    // At 500 req/s with 25ms ticks, each tick should allow ~12-13 requests,
    // never the whole second's worth (500) in one go.
    for (const n of perTick) expect(n).toBeLessThan(50);
  });

  it("ramps from 0 toward targetRps over rampUpSeconds", () => {
    // Two separate schedulers, each warmed up to a different point in the
    // same 10s ramp, then measured over a clean 1s window from there —
    // isolates "how many requests does a 1s window allow at time X" without
    // a single tick call bridging a multi-second gap (which would average
    // the rate across that whole gap instead of measuring a real window).
    const early = new RateScheduler(100, 10, 0);
    const earlyWindow = tickWindow(early, 0, 1000, 25);

    const late = new RateScheduler(100, 10, 0);
    tickWindow(late, 0, 9000, 25); // warm up through most of the ramp, discard
    const lateWindow = tickWindow(late, 9000, 1000, 25);

    expect(lateWindow).toBeGreaterThan(earlyWindow);
  });

  it("carries fractional accrual across ticks instead of losing throughput to rounding", () => {
    // 33 req/s with 25ms ticks: 33 * 0.025 = 0.825 tokens/tick — rounds to
    // 0 almost every tick without carryover, which would starve the rate.
    const start = 0;
    const scheduler = new RateScheduler(33, 0, start);
    let total = 0;
    for (let t = 25; t <= 2000; t += 25) {
      total += scheduler.tick(start + t);
    }
    // Over 2 real seconds at 33/s, expect ~66, comfortably more than 0.
    expect(total).toBeGreaterThan(55);
    expect(total).toBeLessThan(75);
  });
});

function tickWindow(scheduler: RateScheduler, windowStart: number, windowMs: number, stepMs: number): number {
  let total = 0;
  for (let t = stepMs; t <= windowMs; t += stepMs) {
    total += scheduler.tick(windowStart + t);
  }
  return total;
}
