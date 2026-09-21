import { describe, expect, it } from "vitest";
import { advanceBreaker, cooldownRemainingMs, recordProbe, tripBreaker, tryAdmitProbe, type Breaker } from "../../src/core";

const closed: Breaker = { state: "CLOSED", openedAt: null, cooldownMs: 10_000, probeStartedAt: null };

describe("breaker state machine", () => {
  it("trips to OPEN and stays OPEN until the cooldown elapses", () => {
    const b = tripBreaker(closed, 1000);
    expect(b.state).toBe("OPEN");
    expect(advanceBreaker(b, 1000 + 9_999).state).toBe("OPEN");
    expect(cooldownRemainingMs(b, 1000 + 4_000)).toBe(6_000);
    expect(advanceBreaker(b, 1000 + 10_000).state).toBe("HALF_OPEN");
  });

  it("admits exactly one probe while HALF_OPEN", () => {
    const half = advanceBreaker(tripBreaker(closed, 0), 10_000);
    const first = tryAdmitProbe(half, 10_001);
    expect(first.admitted).toBe(true);
    const second = tryAdmitProbe(first.breaker, 10_002);
    expect(second.admitted).toBe(false);
  });

  it("frees a probe slot if the probe never reports back", () => {
    const half = advanceBreaker(tripBreaker(closed, 0), 10_000);
    const { breaker } = tryAdmitProbe(half, 10_001);
    expect(tryAdmitProbe(advanceBreaker(breaker, 12_000), 12_000).admitted).toBe(false);
    expect(tryAdmitProbe(advanceBreaker(breaker, 16_000), 16_000).admitted).toBe(true);
  });

  it("doubles the cooldown on probe failure and caps it at 60 s", () => {
    let b: Breaker = { ...closed, cooldownMs: 40_000 };
    b = recordProbe(b, false, 0);
    expect(b.cooldownMs).toBe(60_000);
    b = recordProbe(b, false, 0);
    expect(b.cooldownMs).toBe(60_000);
    expect(recordProbe(b, true, 0)).toEqual(closed);
  });
});
