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
  type TierChange,
} from "./types";

const HISTORY_MAX = 12;

function pushHistory(history: readonly TierChange[], change: TierChange): TierChange[] {
  const next = [...history, change];
  return next.length > HISTORY_MAX ? next.slice(next.length - HISTORY_MAX) : next;
}

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
    const breakerReasons = [breaker.state === "HALF_OPEN" ? `breaker HALF_OPEN after ${state.breaker.cooldownMs / 1000} s cooldown, waiting for one probe` : `breaker OPEN, probe in ${Math.max(0, Math.ceil((breaker.openedAt !== null ? breaker.openedAt + breaker.cooldownMs - now : 0) / 1000))} s`];
    const transitioned = breaker.state !== state.breaker.state;
    const next: ServiceState = {
      ...state,
      breaker,
      tier: 4,
      window: wid,
      cleanWindows: 0,
      pools: recapPools(refillPools(state.pools, 4, now), 4),
      lastEvaluation: { at: now, signal: "breaker", cleanWindows: 0, reasons: breakerReasons, samples: 0 },
      tierHistory: transitioned ? pushHistory(state.tierHistory, { at: now, from: state.tier, to: 4, breaker: breaker.state, decider: "deterministic", reasons: breakerReasons }) : state.tierHistory,
      updatedAt: now,
    };
    return { state: next, changed: next.tier !== state.tier, reasons: breakerReasons };
  }

  // Everything since the last evaluation counts (capped at two windows), so a burst that ended a few seconds before
  // anyone evaluated the window is still seen. A trailing 5 s view at evaluation time would miss it.
  const since = Math.max(state.lastEvaluation?.at ?? 0, now - 2 * WINDOW_MS);
  const summary = summarize(state.telemetry, since);
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
    reasons.push(`tripped breaker, cooldown ${breaker.cooldownMs / 1000} s`);
  }
  const changed = nextTier !== state.tier;
  reasons.unshift(`window: ${summary.n} calls, ${Math.round(summary.errorRate * 100)}% errors, p95 ${summary.p95Ms} ms, ${summary.timeouts} timeouts`);
  if (changed && nextTier < state.tier) reasons.push(`${THRESHOLDS.cleanWindowsToRecover} clean windows in a row`);
  if (!changed && signal === "clean") reasons.push(`clean window ${cleanWindows} of ${THRESHOLDS.cleanWindowsToRecover} needed to step down`);
  if (!changed && signal === "escalate" && proposal > nextTier) reasons.push("clamped to one step per window");
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
    lastEvaluation: { at: now, signal, cleanWindows, reasons, samples: summary.n },
    tierHistory: changed ? pushHistory(state.tierHistory, { at: now, from: state.tier, to: nextTier, breaker: breaker.state, decider, reasons }) : state.tierHistory,
    updatedAt: now,
  };
  return { state: next, changed, reasons };
}

/** Apply a half-open probe result. Success reopens the ladder at SHED and walks down from there. */
export function applyProbeResult(state: ServiceState, ok: boolean, now: number): ServiceState {
  const breaker = recordProbe(state.breaker, ok, now);
  const tier: Tier = ok ? 3 : 4;
  const reasons = ok ? ["half-open probe succeeded, breaker CLOSED, ladder resumes at SHED"] : [`half-open probe failed, breaker OPEN again, cooldown doubled to ${breaker.cooldownMs / 1000} s`];
  return {
    ...state,
    breaker,
    tier,
    tierChangedAt: tier !== state.tier ? now : state.tierChangedAt,
    cleanWindows: 0,
    pools: recapPools(refillPools(state.pools, tier, now), tier),
    lastEvaluation: { at: now, signal: "breaker", cleanWindows: 0, reasons, samples: 1 },
    tierHistory: pushHistory(state.tierHistory, { at: now, from: state.tier, to: tier, breaker: breaker.state, decider: "deterministic", reasons }),
    updatedAt: now,
  };
}
