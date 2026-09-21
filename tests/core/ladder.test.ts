import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyProbeResult,
  clampStep,
  evaluateWindow,
  initialState,
  proposeTier,
  recordOutcome,
  WINDOW_MS,
  type Outcome,
  type ServiceState,
  type Tier,
} from "../../src/core";

const tierArb = fc.integer({ min: 0, max: 4 }).map((n) => n as Tier);

function withTelemetry(state: ServiceState, outcomes: Partial<Outcome>[], now: number): ServiceState {
  let ring = state.telemetry;
  for (const o of outcomes) ring = recordOutcome(ring, { ok: true, latencyMs: 50, timeout: false, at: now - 100, ...o });
  return { ...state, telemetry: ring };
}

describe("invariant 1: tier moves at most one step per window", () => {
  it("holds for any signal, clean-window count, and Jev proposal", () => {
    fc.assert(
      fc.property(
        tierArb,
        fc.constantFrom("escalate", "clean"),
        fc.integer({ min: 0, max: 5 }),
        fc.option(
          fc.record({ score: fc.double({ min: 0, max: 4, noNaN: true }), confidence: fc.double({ min: 0, max: 1, noNaN: true }) }),
          { nil: null },
        ),
        (current, signal, clean, jev) => {
          const { proposal } = proposeTier(current, signal, clean, jev);
          const next = clampStep(proposal, current);
          expect(Math.abs(next - current)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it("holds end to end: 20 failures with Jev shouting 'down' still climbs one step per window", () => {
    let now = 1_000_000;
    let state = initialState(now);
    const fails = Array.from({ length: 20 }, () => ({ ok: false }));
    const seen: Tier[] = [state.tier];
    for (let w = 0; w < 6; w++) {
      now += WINDOW_MS;
      state = withTelemetry(state, fails, now);
      const ev = evaluateWindow(state, now, { score: 4, confidence: 0.99 }, "jev");
      state = ev.state;
      seen.push(state.tier);
    }
    for (let i = 1; i < seen.length; i++) expect(Math.abs(seen[i]! - seen[i - 1]!)).toBeLessThanOrEqual(1);
    expect(state.tier).toBe(4);
    expect(["OPEN", "HALF_OPEN"]).toContain(state.breaker.state);
  });
});

describe("invariant 2: Jev is advisory", () => {
  it("never lowers the proposal below the deterministic one", () => {
    fc.assert(
      fc.property(
        tierArb,
        fc.constantFrom("escalate", "clean"),
        fc.integer({ min: 0, max: 5 }),
        fc.record({ score: fc.double({ min: 0, max: 4, noNaN: true }), confidence: fc.double({ min: 0, max: 1, noNaN: true }) }),
        (current, signal, clean, jev) => {
          const det = proposeTier(current, signal, clean, null).proposal;
          const withJev = proposeTier(current, signal, clean, jev).proposal;
          expect(withJev).toBeGreaterThanOrEqual(det);
        },
      ),
    );
  });

  it("ignores low-confidence answers and says so", () => {
    const now = 2_000_000 + WINDOW_MS;
    const state = { ...initialState(2_000_000) };
    const ev = evaluateWindow(state, now, { score: 3, confidence: 0.3 }, "jev");
    expect(ev.state.tier).toBe(0);
    expect(ev.state.decider).toBe("jev-bypassed-lowconf");
  });

  it("raises one step on a confident stress score with clean telemetry", () => {
    const now = 3_000_000 + WINDOW_MS;
    const ev = evaluateWindow(initialState(3_000_000), now, { score: 3, confidence: 0.9 }, "jev");
    expect(ev.state.tier).toBe(1);
    expect(ev.state.decider).toBe("jev");
  });

  it("records the bypass tag when Jev was not consulted", () => {
    const now = 4_000_000 + WINDOW_MS;
    const ev = evaluateWindow(initialState(4_000_000), now, null, "jev-bypassed-budget");
    expect(ev.state.decider).toBe("jev-bypassed-budget");
  });
});

describe("recovery walks down one step per two clean windows", () => {
  it("from SHED back to NORMAL", () => {
    let now = 5_000_000;
    let state: ServiceState = { ...initialState(now), tier: 3 };
    const tiers: Tier[] = [];
    for (let w = 0; w < 8; w++) {
      now += WINDOW_MS;
      state = evaluateWindow(state, now, null, "deterministic").state;
      tiers.push(state.tier);
    }
    expect(tiers).toEqual([3, 2, 2, 1, 1, 0, 0, 0]);
  });

  it("probe success reopens at SHED, probe failure doubles the cooldown", () => {
    const now = 6_000_000;
    const state: ServiceState = {
      ...initialState(now),
      tier: 4,
      breaker: { state: "HALF_OPEN", openedAt: now - 10_000, cooldownMs: 10_000, probeStartedAt: now },
    };
    const failed = applyProbeResult(state, false, now);
    expect(failed.breaker.state).toBe("OPEN");
    expect(failed.breaker.cooldownMs).toBe(20_000);
    expect(failed.tier).toBe(4);
    const ok = applyProbeResult(state, true, now);
    expect(ok.breaker.state).toBe("CLOSED");
    expect(ok.tier).toBe(3);
    expect(ok.breaker.cooldownMs).toBe(10_000);
  });
});
