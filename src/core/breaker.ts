import { BREAKER_CFG, type Breaker } from "./types";

// The breaker owns tier 4. Pure transitions on (breaker, now).

export function advanceBreaker(b: Breaker, now: number): Breaker {
  if (b.state === "OPEN" && b.openedAt !== null && now - b.openedAt >= b.cooldownMs) {
    return { ...b, state: "HALF_OPEN", probeStartedAt: null };
  }
  if (b.state === "HALF_OPEN" && b.probeStartedAt !== null && now - b.probeStartedAt > BREAKER_CFG.probeTimeoutMs) {
    // A probe that never reported back (dead invocation) must not wedge recovery.
    return { ...b, probeStartedAt: null };
  }
  return b;
}

export function tripBreaker(b: Breaker, now: number): Breaker {
  return { ...b, state: "OPEN", openedAt: now, probeStartedAt: null };
}

export function tryAdmitProbe(b: Breaker, now: number): { admitted: boolean; breaker: Breaker } {
  if (b.state !== "HALF_OPEN" || b.probeStartedAt !== null) return { admitted: false, breaker: b };
  return { admitted: true, breaker: { ...b, probeStartedAt: now } };
}

export function recordProbe(b: Breaker, ok: boolean, now: number): Breaker {
  if (ok) {
    return { state: "CLOSED", openedAt: null, cooldownMs: BREAKER_CFG.initialCooldownMs, probeStartedAt: null };
  }
  const cooldownMs = Math.min(BREAKER_CFG.maxCooldownMs, b.cooldownMs * 2);
  return { state: "OPEN", openedAt: now, cooldownMs, probeStartedAt: null };
}

export function cooldownRemainingMs(b: Breaker, now: number): number {
  if (b.state !== "OPEN" || b.openedAt === null) return 0;
  return Math.max(0, b.openedAt + b.cooldownMs - now);
}
