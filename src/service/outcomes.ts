import { applyProbeResult, recordOutcome, type Outcome, type ServiceState } from "../core";
import { updateState, type Ctx } from "./context";

// Telemetry and counters. Upstream outcomes feed the ladder; a probe outcome also moves the breaker.

export async function recordUpstream(
  ctx: Ctx,
  outcome: Outcome,
  probe: boolean,
  counters: Record<string, number> = {},
): Promise<ServiceState> {
  const r = await updateState(ctx, (cur, t) => {
    let next: ServiceState = { ...cur, telemetry: recordOutcome(cur.telemetry, outcome), updatedAt: t };
    if (probe) next = applyProbeResult(next, outcome.ok, t);
    const merged: Record<string, number> = { ...next.counters };
    for (const [k, v] of Object.entries(counters)) merged[k] = (merged[k] ?? 0) + v;
    const key = outcome.ok ? "upstreamOk" : "upstreamFail";
    merged[key] = (merged[key] ?? 0) + 1;
    return { value: { ...next, counters: merged }, result: null };
  });
  return r.value;
}

export async function recordBatchOutcomes(ctx: Ctx, outcomes: readonly Outcome[]): Promise<ServiceState> {
  const r = await updateState(ctx, (cur, t) => {
    let ring = cur.telemetry;
    for (const o of outcomes) ring = recordOutcome(ring, o);
    const merged: Record<string, number> = { ...cur.counters };
    merged.batchChunks = (merged.batchChunks ?? 0) + outcomes.length;
    merged.batchChunkFailures = (merged.batchChunkFailures ?? 0) + outcomes.filter((o) => !o.ok).length;
    return { value: { ...cur, telemetry: ring, counters: merged, updatedAt: t }, result: null };
  });
  return r.value;
}

export async function bumpCounters(ctx: Ctx, counters: Record<string, number>): Promise<void> {
  await updateState(ctx, (cur, t) => {
    const merged: Record<string, number> = { ...cur.counters };
    for (const [k, v] of Object.entries(counters)) merged[k] = (merged[k] ?? 0) + v;
    return { value: { ...cur, counters: merged, updatedAt: t }, result: null };
  });
}
