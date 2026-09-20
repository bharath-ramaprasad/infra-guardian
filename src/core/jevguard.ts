import { JEV_BUDGET, type DeciderTag, type JevState } from "./types";

// Budget guard and inner breaker for Jev. Any "no" here means the deterministic policy runs.

export interface JevGate {
  readonly ok: boolean;
  readonly tag: DeciderTag;
  readonly reason: string | null;
}

export function jevGate(j: JevState, now: number): JevGate {
  if (j.off) return { ok: false, tag: "deterministic", reason: "jev=off" };
  if (j.openUntil !== null && now < j.openUntil) return { ok: false, tag: "jev-error", reason: "inner breaker open" };
  const minute = Math.floor(now / 60_000);
  const day = Math.floor(now / 86_400_000);
  const minuteCount = j.minuteBucket === minute ? j.minuteCount : 0;
  const dayCount = j.dayBucket === day ? j.dayCount : 0;
  if (minuteCount >= JEV_BUDGET.perMinute) return { ok: false, tag: "jev-bypassed-budget", reason: "per-minute budget" };
  if (dayCount >= JEV_BUDGET.perDay) return { ok: false, tag: "jev-bypassed-budget", reason: "per-day budget" };
  return { ok: true, tag: "jev", reason: null };
}

export function noteJevCall(j: JevState, now: number): JevState {
  const minute = Math.floor(now / 60_000);
  const day = Math.floor(now / 86_400_000);
  return {
    ...j,
    minuteBucket: minute,
    minuteCount: (j.minuteBucket === minute ? j.minuteCount : 0) + 1,
    dayBucket: day,
    dayCount: (j.dayBucket === day ? j.dayCount : 0) + 1,
    totalCalls: j.totalCalls + 1,
  };
}

export function noteJevSuccess(j: JevState): JevState {
  return { ...j, consecutiveErrors: 0, openUntil: null };
}

export function noteJevError(j: JevState, now: number): JevState {
  const consecutiveErrors = j.consecutiveErrors + 1;
  const openUntil = consecutiveErrors >= JEV_BUDGET.errorsToOpen ? now + JEV_BUDGET.openMs : j.openUntil;
  return { ...j, consecutiveErrors, openUntil };
}
