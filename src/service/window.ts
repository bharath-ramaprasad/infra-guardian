import { WINDOW_MS, evaluateWindow, isWindowStale, summarize, type DeciderTag, type JevLast, type ServiceState } from "../core";
import { updateState, type Ctx } from "./context";
import { applyJevCounters, consultJev } from "./jev";

export interface WindowResult {
  readonly state: ServiceState;
  readonly evaluated: boolean;
  readonly reasons: readonly string[];
}

/** Evaluate the window if it is stale, consulting Jev for the stress score when allowed. */
export async function ensureWindow(ctx: Ctx, state: ServiceState, now: number, allowJev = true): Promise<WindowResult> {
  if (!isWindowStale(state, now)) return { state, evaluated: false, reasons: [] };
  const since = Math.max(state.lastEvaluation?.at ?? 0, now - 2 * WINDOW_MS);
  const summary = summarize(state.telemetry, since);
  const previous = summarize(state.telemetry, since - WINDOW_MS);
  const recent = state.telemetry.slice(-15).map((o) => ({ ok: o.ok, latencyMs: o.latencyMs, timeout: o.timeout }));
  const call =
    allowJev && summary.n > 0 && state.breaker.state === "CLOSED"
      ? await consultJev(ctx, state, now, (signal) => ctx.decider.stress({ tier: state.tier, summary, previous, recent }, signal))
      : { answer: null, tag: "deterministic" as DeciderTag, latencyMs: 0, error: null, gated: "idle" };
  const last: JevLast | null = call.answer
    ? { kind: "stress", at: now, latencyMs: call.latencyMs, answers: { stress: call.answer }, decider: "jev" }
    : null;
  const r = await updateState(ctx, (cur, t) => {
    if (!isWindowStale(cur, t)) return { value: cur, result: { evaluated: false, reasons: [] as readonly string[] } };
    const counted = applyJevCounters(cur, call, t, last);
    const ev = evaluateWindow(counted, t, call.answer ? { score: call.answer.score, confidence: call.answer.confidence } : null, call.tag);
    if (ev.changed) {
      console.info(
        JSON.stringify({
          event: "tier.change",
          sid: ctx.sid,
          from: cur.tier,
          to: ev.state.tier,
          decider: ev.state.decider,
          reasons: ev.reasons,
        }),
      );
    }
    return { value: ev.state, result: { evaluated: true, reasons: ev.reasons } };
  });
  return { state: r.value, evaluated: r.result.evaluated, reasons: r.result.reasons };
}
