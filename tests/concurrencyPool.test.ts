import { describe, it, expect } from "vitest";
import { ConcurrencyPool } from "../src/concurrencyPool.js";

describe("ConcurrencyPool", () => {
  it("refuses acquisition once at max concurrency", () => {
    const pool = new ConcurrencyPool(2);
    expect(pool.tryAcquire()).toBe(true);
    expect(pool.tryAcquire()).toBe(true);
    expect(pool.tryAcquire()).toBe(false); // third exceeds max=2
    expect(pool.activeCount).toBe(2);
  });

  it("frees a slot on release, allowing a new acquisition", () => {
    const pool = new ConcurrencyPool(1);
    expect(pool.tryAcquire()).toBe(true);
    expect(pool.tryAcquire()).toBe(false);
    pool.release();
    expect(pool.tryAcquire()).toBe(true);
  });

  it("tracks peak concurrency even after slots are released", () => {
    const pool = new ConcurrencyPool(5);
    pool.tryAcquire();
    pool.tryAcquire();
    pool.tryAcquire();
    expect(pool.peakCount).toBe(3);
    pool.release();
    pool.release();
    expect(pool.activeCount).toBe(1);
    expect(pool.peakCount).toBe(3); // peak doesn't decay
  });

  it("never goes negative on an unmatched release", () => {
    const pool = new ConcurrencyPool(1);
    pool.release();
    expect(pool.activeCount).toBe(0);
  });
});
