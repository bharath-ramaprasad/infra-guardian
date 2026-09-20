import { advanceBreaker, cooldownRemainingMs, tryAdmitProbe } from "./breaker";
import { hedgeDecision, type HedgeDecision } from "./hedge";
import { hasCapacity, refillPools, takeTokens } from "./pools";
import { summarize } from "./telemetry";
import { CRITICAL_RESERVE_SHARE, WAIT_BUDGET_MS, WINDOW_MS, poolCapacity, type ClassCacheEntry, type Priority, type ServiceState } from "./types";

// One admission attempt for an interactive request. Waiting between attempts is the caller's job (it is I/O).

export interface AdmissionInput {
  readonly state: ServiceState;
  readonly now: number;
  readonly cls: ClassCacheEntry;
  readonly idempotent: boolean;
  readonly hedgeEnabled: boolean;
}

export type Admission =
  | { readonly kind: "fail-fast"; readonly retryAfterMs: number; readonly state: ServiceState }
  | { readonly kind: "probe"; readonly state: ServiceState }
  | { readonly kind: "admit"; readonly from: Priority; readonly hedge: HedgeDecision; readonly state: ServiceState }
  | { readonly kind: "reject"; readonly status: 429 | 503; readonly reason: "pool-empty" | "shed"; readonly retryAfterMs: number; readonly state: ServiceState };

export function decideAdmission(i: AdmissionInput): Admission {
  const { now, cls } = i;
  let state = i.state;
  const breaker = advanceBreaker(state.breaker, now);
  if (breaker !== state.breaker) state = { ...state, breaker };

  if (state.breaker.state === "OPEN") {
    return { kind: "fail-fast", retryAfterMs: cooldownRemainingMs(state.breaker, now), state };
  }
  if (state.breaker.state === "HALF_OPEN") {
    const probe = tryAdmitProbe(state.breaker, now);
    if (probe.admitted) return { kind: "probe", state: { ...state, breaker: probe.breaker } };
    return { kind: "fail-fast", retryAfterMs: 1000, state };
  }

  const pools = refillPools(state.pools, state.tier, now);
  state = { ...state, pools };
  if (!hasCapacity(state.tier, cls.priority)) {
    return { kind: "reject", status: 503, reason: "shed", retryAfterMs: WINDOW_MS, state };
  }
  const take = takeTokens(pools, state.tier, cls.priority, 1);
  if (!take.ok) {
    const yieldRequestedAt = cls.priority === "critical" ? now : state.yieldRequestedAt;
    return {
      kind: "reject",
      status: 429,
      reason: "pool-empty",
      retryAfterMs: Math.max(1, take.retryAfterMs),
      state: { ...state, yieldRequestedAt },
    };
  }
  const p50Ms = summarize(state.telemetry, now - WINDOW_MS * 2).p50Ms;
  const hedge = hedgeDecision({
    tier: state.tier,
    pools: take.pools,
    priority: cls.priority,
    idempotent: i.idempotent,
    safeToRetry: cls.safeToRetry,
    p50Ms,
    enabled: i.hedgeEnabled,
  });
  // A critical request that eats into the critical reserve is pressure: raise the yield flag so batch work steps aside.
  const reserve = Math.max(1, poolCapacity(state.tier, "critical") * CRITICAL_RESERVE_SHARE);
  const yieldRequestedAt = cls.priority === "critical" && take.pools.critical < reserve ? now : state.yieldRequestedAt;
  return { kind: "admit", from: take.from ?? cls.priority, hedge, state: { ...state, pools: take.pools, yieldRequestedAt } };
}

/** Probability-weighted wait budget. Low-confidence classifications already collapsed to standard upstream. */
export function waitBudgetMs(probabilities: Readonly<Record<Priority, number>>): number {
  let total = 0;
  let mass = 0;
  for (const cls of Object.keys(WAIT_BUDGET_MS) as Priority[]) {
    const p = probabilities[cls] ?? 0;
    total += p * WAIT_BUDGET_MS[cls];
    mass += p;
  }
  return mass > 0 ? Math.round(total / mass) : WAIT_BUDGET_MS.standard;
}
