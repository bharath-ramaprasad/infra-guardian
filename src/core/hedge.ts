import { CONFIDENCE_SAFE_TO_RETRY, type Pools, type Priority, type Tier } from "./types";

// Delayed 1:2 hedge, critical class only. All four gates must pass; the idempotency gate is deterministic.

export type HedgeGate = "class" | "tier" | "pool" | "idempotency" | "safeToRetry";

export interface HedgeInput {
  readonly tier: Tier;
  readonly pools: Pools;
  readonly priority: Priority;
  readonly idempotent: boolean;
  readonly safeToRetry: number;
  readonly p50Ms: number;
  readonly enabled: boolean;
}

export interface HedgeDecision {
  readonly allowed: boolean;
  readonly gate: HedgeGate | "off" | null;
  readonly delayMs: number;
}

/** Copy 2 goes out only after 1.5× the rolling p50, so ordinary requests never hedge and tail requests do.
 *  Until there are enough samples the basis is unknown and a conservative default applies. */
export const HEDGE_DELAY = { floorMs: 50, capMs: 2000, headroom: 1.5, defaultMs: 300 } as const;

export function hedgeDelayMs(p50Ms: number): number {
  const basis = p50Ms > 0 ? p50Ms * HEDGE_DELAY.headroom : HEDGE_DELAY.defaultMs;
  return Math.min(HEDGE_DELAY.capMs, Math.max(HEDGE_DELAY.floorMs, Math.round(basis)));
}

export function hedgeDecision(i: HedgeInput): HedgeDecision {
  const delayMs = hedgeDelayMs(i.p50Ms);
  if (!i.enabled) return { allowed: false, gate: "off", delayMs };
  if (i.priority !== "critical") return { allowed: false, gate: "class", delayMs };
  if (i.tier > 1) return { allowed: false, gate: "tier", delayMs };
  if (i.pools.critical < 2) return { allowed: false, gate: "pool", delayMs };
  if (!i.idempotent) return { allowed: false, gate: "idempotency", delayMs };
  if (i.safeToRetry < CONFIDENCE_SAFE_TO_RETRY) return { allowed: false, gate: "safeToRetry", delayMs };
  return { allowed: true, gate: null, delayMs };
}
