import { describe, expect, it } from "vitest";
import { decideAdmission, initialState, waitBudgetMs, type ClassCacheEntry, type ServiceState } from "../src/core";

const now = 30_000_000;
const critical: ClassCacheEntry = { priority: "critical", probabilities: { critical: 0.9, standard: 0.1, bulk: 0 }, confidence: 0.9, safeToRetry: 0.95, decider: "jev", at: now };
const bulk: ClassCacheEntry = { ...critical, priority: "bulk", probabilities: { critical: 0, standard: 0.2, bulk: 0.8 } };

describe("admission decisions", () => {
  it("fails fast while OPEN and admits a single probe while HALF_OPEN", () => {
    const open: ServiceState = { ...initialState(now), tier: 4, breaker: { state: "OPEN", openedAt: now - 1000, cooldownMs: 10_000, probeStartedAt: null } };
    const ff = decideAdmission({ state: open, now, cls: critical, idempotent: true, hedgeEnabled: true });
    expect(ff.kind).toBe("fail-fast");
    if (ff.kind === "fail-fast") expect(ff.retryAfterMs).toBe(9_000);
    const later = now + 10_000;
    const probe = decideAdmission({ state: open, now: later, cls: critical, idempotent: true, hedgeEnabled: true });
    expect(probe.kind).toBe("probe");
    const second = decideAdmission({ state: probe.state, now: later + 1, cls: critical, idempotent: true, hedgeEnabled: true });
    expect(second.kind).toBe("fail-fast");
  });

  it("sheds classes with no share at the current tier", () => {
    const hard: ServiceState = { ...initialState(now), tier: 2 };
    const r = decideAdmission({ state: hard, now, cls: bulk, idempotent: true, hedgeEnabled: true });
    expect(r.kind).toBe("reject");
    if (r.kind === "reject") expect(r.status).toBe(503);
  });

  it("raises the yield flag when a critical request finds its pool empty", () => {
    const drained: ServiceState = { ...initialState(now), pools: { critical: 0, standard: 0, bulk: 0, refilledAt: now } };
    const r = decideAdmission({ state: drained, now, cls: critical, idempotent: true, hedgeEnabled: true });
    expect(r.kind).toBe("reject");
    if (r.kind === "reject") {
      expect(r.status).toBe(429);
      expect(r.retryAfterMs).toBeGreaterThan(0);
    }
    expect(r.state.yieldRequestedAt).toBe(now);
    const b = decideAdmission({ state: drained, now, cls: bulk, idempotent: true, hedgeEnabled: true });
    expect(b.state.yieldRequestedAt).toBeNull();
  });

  it("admits with a hedge only for idempotent critical requests", () => {
    const s = initialState(now);
    const a = decideAdmission({ state: s, now, cls: critical, idempotent: true, hedgeEnabled: true });
    expect(a.kind).toBe("admit");
    if (a.kind === "admit") {
      expect(a.hedge.allowed).toBe(true);
      expect(a.state.pools.critical).toBe(19);
    }
    const b = decideAdmission({ state: s, now, cls: critical, idempotent: false, hedgeEnabled: true });
    if (b.kind === "admit") expect(b.hedge.gate).toBe("idempotency");
  });

  it("weights the wait budget by class probabilities", () => {
    expect(waitBudgetMs({ critical: 1, standard: 0, bulk: 0 })).toBe(0);
    expect(waitBudgetMs({ critical: 0, standard: 0.6, bulk: 0.4 })).toBe(900);
    expect(waitBudgetMs({ critical: 0, standard: 0, bulk: 1 })).toBe(1500);
  });
});
