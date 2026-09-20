import { advanceBreaker, recordProbe, tripBreaker } from "./breaker";
import { recapPools, refillPools } from "./pools";
import { deterministicSignal, escalationReasons, summarize } from "./telemetry";
import {
  CONFIDENCE_GENERAL,
  THRESHOLDS,
  WINDOW_MS,
  clampTier,
  type DeciderTag,
  type ServiceState,
  type Tier,
} from "./types";

// The tier ladder. Invariant: |tier(next) − tier(current)| ≤ 1 per window, and Jev can only raise the proposal.

export interface StressProposal {
  readonly score: number;
  readonly confidence: number;
}

export interface WindowEvaluation {
  readonly state: ServiceState;
  readonly changed: boolean;
  readonly reasons: readonly string[];
}

export function windowId(now: number): number {
  return Math.floor(now / WINDOW_MS);
}

export function isWindowStale(state: ServiceState, now: number): boolean {
  return windowId(now) > state.window;
}

export function proposeTier(
  current: Tier,
  signal: "escalate" | "clean",
  cleanWindows: number,
  jev: StressProposal | null,
): { proposal: Tier; jevUsed: boolean; jevIgnored: boolean } {
  let det: number = current;
  if (signal === "escalate") det = current + 1;
  else if (cleanWindows >= THRESHOLDS.cleanWindowsToRecover) det = current - 1;
  let jevUsed = false;
  let jevIgnored = false;
  let proposal = det;
  if (jev !== null) {
    if (jev.confidence >= CONFIDENCE_GENERAL) {
      const jevTier = clampTier(jev.score);
      if (jevTier > det) {
        proposal = jevTier;
        jevUsed = true;
      }
    } else {
      jevIgnored = true;
    }
  }
  return { proposal: clampTier(proposal), jevUsed, jevIgnored };
}

export function clampStep(proposal: Tier, current: Tier): Tier {
  return clampTier(Math.max(current - 1, Math.min(current + 1, proposal)));
}

/**
 * Evaluate one window. `jev` is the stress answer for this window, or null when Jev was not consulted;
 * `jevTag` says why (budget, error, off) so the decider header is honest.
 */
export function evaluateWindow(
  state: ServiceState,
  now: number,
  jev: StressProposal | null,
  jevTag: DeciderTag,
): WindowEvaluation {
  if (!isWindowStale(state, now)) return { state, changed: false, reasons: [] };
  const wid = windowId(now);
  const reasons: string[] = [];
  let breaker = advanceBreaker(state.breaker, now);

  // Breaker owns tier 4: while it is not CLOSED the ladder does not run.
  if (breaker.state !== "CLOSED") {
    const next: ServiceState = {
      ...state,
      breaker,
      tier: 4,
      window: wid,
      cleanWindows: 0,
      pools: recapPools(refillPools(state.pools, 4, now), 4),
      updatedAt: now,
    };
    return { state: next, changed: next.tier !== state.tier, reasons: [`breaker ${breaker.state}`] };
  }

  const summary = summarize(state.telemetry, now - WINDOW_MS);
  const signal = deterministicSignal(summary);
  const cleanWindows = signal === "clean" ? state.cleanWindows + 1 : 0;
  reasons.push(...escalationReasons(summary));
  const { proposal, jevUsed, jevIgnored } = proposeTier(state.tier, signal, cleanWindows, jev);
  const nextTier = clampStep(proposal, state.tier);

  let decider: DeciderTag = jevTag;
  if (jev !== null) {
    if (jevUsed) {
      decider = "jev";
      reasons.push(`jev stress ${jev.score.toFixed(2)} conf ${jev.confidence.toFixed(2)}`);
    } else if (jevIgnored) {
      decider = "jev-bypassed-lowconf";
    } else {
      decider = "jev"; // consulted, agreed with or below deterministic
    }
  }

  if (nextTier === 4) {
    breaker = tripBreaker(breaker, now);
    reasons.push("tripped breaker");
  }
  const changed = nextTier !== state.tier;
  const next: ServiceState = {
    ...state,
    tier: nextTier,
    tierChangedAt: changed ? now : state.tierChangedAt,
    breaker,
    window: wid,
    cleanWindows: changed ? 0 : cleanWindows,
    pools: recapPools(refillPools(state.pools, nextTier, now), nextTier),
    decider,
    lastStress: jev ? { score: jev.score, confidence: jev.confidence, at: now } : state.lastStress,
    updatedAt: now,
  };
  return { state: next, changed, reasons };
}

/** Apply a half-open probe result. Success reopens the ladder at SHED and walks down from there. */
export function applyProbeResult(state: ServiceState, ok: boolean, now: number): ServiceState {
  const breaker = recordProbe(state.breaker, ok, now);
  const tier: Tier = ok ? 3 : 4;
  return {
    ...state,
    breaker,
    tier,
    tierChangedAt: tier !== state.tier ? now : state.tierChangedAt,
    cleanWindows: 0,
    pools: recapPools(refillPools(state.pools, tier, now), tier),
    updatedAt: now,
  };
}
