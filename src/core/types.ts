// Shared types and the policy tables. Pure data, no I/O.

export type Tier = 0 | 1 | 2 | 3 | 4;
export const TIER_NAMES = ["NORMAL", "SOFT_THROTTLE", "HARD_THROTTLE", "SHED", "OPEN"] as const;
export type TierName = (typeof TIER_NAMES)[number];

export const PRIORITIES = ["critical", "standard", "bulk"] as const;
export type Priority = (typeof PRIORITIES)[number];

export type BreakerStateName = "CLOSED" | "HALF_OPEN" | "OPEN";

export interface TierSpec {
  readonly name: TierName;
  readonly tokensPerSec: number;
  readonly shares: Readonly<Record<Priority, number>>;
  readonly borrowing: boolean;
  readonly batchChunksPerSec: number;
}

export const TIERS: Readonly<Record<Tier, TierSpec>> = {
  0: { name: "NORMAL", tokensPerSec: 50, shares: { critical: 0.4, standard: 0.4, bulk: 0.2 }, borrowing: true, batchChunksPerSec: 10 },
  1: { name: "SOFT_THROTTLE", tokensPerSec: 30, shares: { critical: 0.5, standard: 0.35, bulk: 0.15 }, borrowing: true, batchChunksPerSec: 5 },
  2: { name: "HARD_THROTTLE", tokensPerSec: 15, shares: { critical: 0.6, standard: 0.4, bulk: 0 }, borrowing: false, batchChunksPerSec: 0 },
  3: { name: "SHED", tokensPerSec: 5, shares: { critical: 1, standard: 0, bulk: 0 }, borrowing: false, batchChunksPerSec: 0 },
  4: { name: "OPEN", tokensPerSec: 0, shares: { critical: 0, standard: 0, bulk: 0 }, borrowing: false, batchChunksPerSec: 0 },
};

export const WINDOW_MS = 5_000;
export const YIELD_TTL_MS = 3_000;
/** Critical pool below this share of its capacity counts as pressure: batch yields and the yield flag is raised. */
export const CRITICAL_RESERVE_SHARE = 0.25;
export const WAIT_BUDGET_MS: Readonly<Record<Priority, number>> = { critical: 0, standard: 500, bulk: 1500 };
export const CONFIDENCE_GENERAL = 0.6;
export const CONFIDENCE_SAFE_TO_RETRY = 0.7;
export const THRESHOLDS = { errorRate: 0.5, minSamples: 10, p95Ms: 1500, p95MinSamples: 5, timeouts: 5, cleanWindowsToRecover: 2 } as const;
export const BREAKER_CFG = { initialCooldownMs: 10_000, maxCooldownMs: 60_000, probeTimeoutMs: 5_000 } as const;
export const BATCH_CFG = { chunkMs: 200, stepBudgetMs: 3_000, agingMs: 10_000, resumeStaggerMaxMs: 500, maxItems: 5_000, chunkSize: 5 } as const;
export const JEV_BUDGET = { perMinute: 60, perDay: 3_000, errorsToOpen: 3, openMs: 30_000, timeoutMs: 800, classCacheMs: 60_000, classCacheMax: 32 } as const;
export const UPSTREAM_CFG = { timeoutMs: 2_000, maxLatencyMs: 2_000, tailMultiplier: 5 } as const;
export const TELEMETRY_RING = 50;

export interface Outcome {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly timeout: boolean;
  readonly at: number;
}

export interface Breaker {
  readonly state: BreakerStateName;
  readonly openedAt: number | null;
  readonly cooldownMs: number;
  readonly probeStartedAt: number | null;
}

export interface Pools {
  readonly critical: number;
  readonly standard: number;
  readonly bulk: number;
  readonly refilledAt: number;
}

export type DeciderTag = "jev" | "deterministic" | "jev-bypassed-budget" | "jev-bypassed-lowconf" | "jev-error";

export interface JevState {
  readonly off: boolean;
  readonly minuteBucket: number;
  readonly minuteCount: number;
  readonly dayBucket: number;
  readonly dayCount: number;
  readonly consecutiveErrors: number;
  readonly openUntil: number | null;
  readonly totalCalls: number;
  readonly last: JevLast | null;
  readonly lastError: { readonly at: number; readonly message: string; readonly latencyMs: number } | null;
}

export interface JevLast {
  readonly kind: "classify" | "stress" | "deferability";
  readonly at: number;
  readonly latencyMs: number;
  readonly answers: Record<string, unknown>;
  readonly decider: DeciderTag;
}

export interface ClassCacheEntry {
  readonly pending?: boolean;
  readonly priority: Priority;
  readonly probabilities: Readonly<Record<Priority, number>>;
  readonly confidence: number;
  readonly safeToRetry: number;
  readonly decider: DeciderTag;
  readonly at: number;
}

export interface TierChange {
  readonly at: number;
  readonly from: Tier;
  readonly to: Tier;
  readonly breaker: BreakerStateName;
  readonly decider: DeciderTag;
  readonly reasons: readonly string[];
}

export interface LastEvaluation {
  readonly at: number;
  readonly signal: "escalate" | "clean" | "breaker";
  readonly cleanWindows: number;
  readonly reasons: readonly string[];
  readonly samples: number;
}

export interface ServiceState {
  readonly version: 1;
  readonly tier: Tier;
  readonly tierChangedAt: number;
  readonly tierHistory: readonly TierChange[];
  readonly lastEvaluation: LastEvaluation | null;
  readonly breaker: Breaker;
  readonly pools: Pools;
  readonly telemetry: readonly Outcome[];
  readonly window: number;
  readonly cleanWindows: number;
  readonly yieldRequestedAt: number | null;
  readonly jev: JevState;
  readonly classCache: Readonly<Record<string, ClassCacheEntry>>;
  readonly decider: DeciderTag;
  readonly lastStress: { readonly score: number; readonly confidence: number; readonly at: number } | null;
  readonly counters: Readonly<Record<string, number>>;
  readonly updatedAt: number;
}

export type JobStateName = "QUEUED" | "RUNNING" | "PREEMPTED" | "DONE" | "CANCELLED";

export interface JobEvent {
  readonly at: number;
  readonly event: string;
  readonly detail?: string;
}

export interface Job {
  readonly id: string;
  readonly description: string;
  readonly items: number;
  readonly cursor: number;
  readonly chunkSize: number;
  readonly state: JobStateName;
  readonly deferability: number;
  readonly deferabilityConfidence: number;
  readonly deferabilityDecider: DeciderTag;
  readonly submittedAt: number;
  readonly resumeAfter: number | null;
  readonly lastChunkAt: number | null;
  readonly resumes: number;
  readonly preemptions: number;
  readonly history: readonly JobEvent[];
  readonly updatedAt: number;
}

export function tierSpec(t: Tier): TierSpec {
  return TIERS[t];
}

export function clampTier(n: number): Tier {
  const v = Math.max(0, Math.min(4, Math.round(n)));
  return v as Tier;
}

export function initialState(now: number): ServiceState {
  return {
    version: 1,
    tier: 0,
    tierChangedAt: now,
    tierHistory: [],
    lastEvaluation: null,
    breaker: { state: "CLOSED", openedAt: null, cooldownMs: BREAKER_CFG.initialCooldownMs, probeStartedAt: null },
    pools: fullPools(0, now),
    telemetry: [],
    window: Math.floor(now / WINDOW_MS),
    cleanWindows: 0,
    yieldRequestedAt: null,
    jev: { off: false, minuteBucket: 0, minuteCount: 0, dayBucket: 0, dayCount: 0, consecutiveErrors: 0, openUntil: null, totalCalls: 0, last: null, lastError: null },
    classCache: {},
    decider: "deterministic",
    lastStress: null,
    counters: {},
    updatedAt: now,
  };
}

export function poolCapacity(tier: Tier, cls: Priority): number {
  const spec = tierSpec(tier);
  const cap = spec.tokensPerSec * spec.shares[cls];
  return cap > 0 ? Math.max(1, cap) : 0;
}

export function fullPools(tier: Tier, now: number): Pools {
  return {
    critical: poolCapacity(tier, "critical"),
    standard: poolCapacity(tier, "standard"),
    bulk: poolCapacity(tier, "bulk"),
    refilledAt: now,
  };
}
