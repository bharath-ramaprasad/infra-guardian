import { TELEMETRY_RING, THRESHOLDS, type Outcome } from "./types";

export interface TelemetrySummary {
  readonly n: number;
  readonly errors: number;
  readonly errorRate: number;
  readonly timeouts: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export function recordOutcome(ring: readonly Outcome[], outcome: Outcome): Outcome[] {
  const next = [...ring, outcome];
  return next.length > TELEMETRY_RING ? next.slice(next.length - TELEMETRY_RING) : next;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

export function summarize(ring: readonly Outcome[], since: number): TelemetrySummary {
  const recent = ring.filter((o) => o.at >= since);
  const n = recent.length;
  const errors = recent.filter((o) => !o.ok).length;
  const timeouts = recent.filter((o) => o.timeout).length;
  const sorted = recent.map((o) => o.latencyMs).sort((a, b) => a - b);
  return {
    n,
    errors,
    errorRate: n === 0 ? 0 : errors / n,
    timeouts,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

export type Signal = "escalate" | "clean";

export function deterministicSignal(s: TelemetrySummary): Signal {
  if (s.n >= THRESHOLDS.minSamples && s.errorRate >= THRESHOLDS.errorRate) return "escalate";
  if (s.n >= THRESHOLDS.p95MinSamples && s.p95Ms >= THRESHOLDS.p95Ms) return "escalate";
  if (s.timeouts >= THRESHOLDS.timeouts) return "escalate";
  return "clean";
}

export function escalationReasons(s: TelemetrySummary): string[] {
  const r: string[] = [];
  if (s.n >= THRESHOLDS.minSamples && s.errorRate >= THRESHOLDS.errorRate)
    r.push(`error rate ${(s.errorRate * 100).toFixed(0)}% over ${s.n}`);
  if (s.n >= THRESHOLDS.p95MinSamples && s.p95Ms >= THRESHOLDS.p95Ms) r.push(`p95 ${s.p95Ms} ms`);
  if (s.timeouts >= THRESHOLDS.timeouts) r.push(`${s.timeouts} timeouts`);
  return r;
}
