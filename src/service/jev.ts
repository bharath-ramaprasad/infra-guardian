import { JEV_BUDGET, jevGate, noteJevCall, noteJevError, noteJevSuccess, type DeciderTag, type JevLast, type ServiceState } from "../core";
import type { Ctx } from "./context";

// One Jev call under the budget guard and inner breaker. The counters are applied inside the caller's CAS update
// so they are never lost to a lost race.

export interface JevCall<T> {
  readonly answer: T | null;
  readonly tag: DeciderTag;
  readonly latencyMs: number;
  readonly error: string | null;
  readonly gated: string | null;
}

export async function consultJev<T>(
  ctx: Ctx,
  state: ServiceState,
  now: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<JevCall<T>> {
  const gate = jevGate(state.jev, now);
  if (!gate.ok) return { answer: null, tag: gate.tag, latencyMs: 0, error: null, gated: gate.reason };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), JEV_BUDGET.timeoutMs + 50);
  const started = Date.now();
  try {
    const answer = await call(ac.signal);
    return { answer, tag: "jev", latencyMs: Date.now() - started, error: null, gated: null };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.warn(JSON.stringify({ event: "jev.error", sid: ctx.sid, message }));
    return { answer: null, tag: "jev-error", latencyMs: Date.now() - started, error: message, gated: null };
  } finally {
    clearTimeout(timer);
  }
}

export function applyJevCounters(state: ServiceState, call: JevCall<unknown>, now: number, last: JevLast | null): ServiceState {
  if (call.gated !== null) return state;
  let jev = noteJevCall(state.jev, now);
  jev = call.error === null ? noteJevSuccess(jev) : noteJevError(jev, now);
  if (call.error !== null) jev = { ...jev, lastError: { at: now, message: call.error.slice(0, 200), latencyMs: call.latencyMs } };
  return { ...state, jev: last ? { ...jev, last } : jev };
}
