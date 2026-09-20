import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fullPools, hedgeDecision, type Priority, type Tier } from "../src/core";

describe("invariant 3: hedging needs all four gates", () => {
  const base = { tier: 0 as Tier, pools: fullPools(0, 0), priority: "critical" as Priority, idempotent: true, safeToRetry: 0.95, p50Ms: 120, enabled: true };

  it("fires when every gate passes, with a bounded delay", () => {
    const d = hedgeDecision(base);
    expect(d.allowed).toBe(true);
    expect(d.delayMs).toBe(180);
    expect(hedgeDecision({ ...base, p50Ms: 5 }).delayMs).toBe(50);
    expect(hedgeDecision({ ...base, p50Ms: 9_000 }).delayMs).toBe(2000);
    expect(hedgeDecision({ ...base, p50Ms: 0 }).delayMs).toBe(300);
  });

  it("names the failing gate", () => {
    expect(hedgeDecision({ ...base, priority: "standard" }).gate).toBe("class");
    expect(hedgeDecision({ ...base, tier: 2, pools: fullPools(2, 0) }).gate).toBe("tier");
    expect(hedgeDecision({ ...base, pools: { ...base.pools, critical: 1.5 } }).gate).toBe("pool");
    expect(hedgeDecision({ ...base, idempotent: false }).gate).toBe("idempotency");
    expect(hedgeDecision({ ...base, safeToRetry: 0.69 }).gate).toBe("safeToRetry");
    expect(hedgeDecision({ ...base, enabled: false }).gate).toBe("off");
  });

  it("never fires at HARD_THROTTLE or above, whatever else is true", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 4 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.boolean(), (tier, safe, idem) => {
        const d = hedgeDecision({ ...base, tier: tier as Tier, pools: { critical: 99, standard: 99, bulk: 99, refilledAt: 0 }, safeToRetry: safe, idempotent: idem });
        expect(d.allowed).toBe(false);
      }),
    );
  });
});
