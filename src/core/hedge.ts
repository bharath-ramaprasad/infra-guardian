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

export const HEDGE_DELAY = { floorMs: 50, capMs: 2000 } as const;

export function hedgeDecision(i: HedgeInput): HedgeDecision {
  const delayMs = Math.min(HEDGE_DELAY.capMs, Math.max(HEDGE_DELAY.floorMs, Math.round(i.p50Ms)));
  if (!i.enabled) return { allowed: false, gate: "off", delayMs };
  if (i.priority !== "critical") return { allowed: false, gate: "class", delayMs };
  if (i.tier > 1) return { allowed: false, gate: "tier", delayMs };
  if (i.pools.critical < 2) return { allowed: false, gate: "pool", delayMs };
  if (!i.idempotent) return { allowed: false, gate: "idempotency", delayMs };
  if (i.safeToRetry < CONFIDENCE_SAFE_TO_RETRY) return { allowed: false, gate: "safeToRetry", delayMs };
  return { allowed: true, gate: null, delayMs };
}
