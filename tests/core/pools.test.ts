import { describe, expect, it } from "vitest";
import { fullPools, hasCapacity, poolCapacity, refillPools, takeTokens } from "../../src/core";

describe("class pools", () => {
  it("sizes pools by tier share", () => {
    expect(poolCapacity(0, "critical")).toBe(20);
    expect(poolCapacity(0, "bulk")).toBe(10);
    expect(poolCapacity(2, "bulk")).toBe(0);
    expect(poolCapacity(3, "critical")).toBe(5);
    expect(hasCapacity(2, "bulk")).toBe(false);
  });

  it("borrows from the fullest other class only in tiers 0 and 1", () => {
    const p0 = { ...fullPools(0, 0), bulk: 0 };
    const t = takeTokens(p0, 0, "bulk");
    expect(t.ok).toBe(true);
    expect(t.from).toBe("critical");
    const p2 = { ...fullPools(2, 0), standard: 0 };
    const n = takeTokens(p2, 2, "standard");
    expect(n.ok).toBe(false);
    expect(n.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills continuously and never exceeds capacity", () => {
    const empty = { critical: 0, standard: 0, bulk: 0, refilledAt: 0 };
    const half = refillPools(empty, 0, 500);
    expect(half.critical).toBeCloseTo(10);
    const over = refillPools(empty, 0, 60_000);
    expect(over.critical).toBe(20);
  });
});
