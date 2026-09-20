import {
  CONFIDENCE_GENERAL,
  JEV_BUDGET,
  WINDOW_MS,
  applyProbeResult,
  evaluateWindow,
  initialState,
  isWindowStale,
  jevGate,
  noteJevCall,
  noteJevError,
  noteJevSuccess,
  recordOutcome,
  summarize,
  type ClassCacheEntry,
  type DeciderTag,
  type Job,
  type JevLast,
  type Outcome,
  type ServiceState,
} from "./core";
import { sha256 } from "./http";
import { resolveDecider, type Decider } from "./jev";
import { resolveStore, updateWithCas, type Store } from "./store";

// Orchestration shared by the functions: state loading, window evaluation with Jev, classification with cache,
// outcome recording, and the session index the scheduled tick walks. Every write is a CAS update.

export interface Ctx {
  readonly sid: string;
  readonly store: Store;
  readonly degraded: boolean;
  readonly decider: Decider;
  readonly stateKey: string;
}

export const SESSIONS_KEY = "sessions";

export async function makeCtx(sid: string): Promise<Ctx> {
  const { store, degraded } = await resolveStore();
  return { sid, store, degraded, decider: resolveDecider(), stateKey: `s/${sid}/svc` };
}

/** The yield flag lives on its own key with plain last-writer-wins writes, so critical pressure is recorded even when
 *  the main state key is contended. Readers merge it into `state.yieldRequestedAt` before deciding. */
export function yieldKey(sid: string): string {
  return `s/${sid}/yield`;
}

export async function raiseYield(ctx: Ctx, now: number): Promise<void> {
  try {
    await ctx.store.set(yieldKey(ctx.sid), { at: now });
  } catch (err) {
    console.warn(JSON.stringify({ event: "yield.write_failed", sid: ctx.sid, message: err instanceof Error ? err.message : String(err) }));
  }
}

export async function withYield(ctx: Ctx, state: ServiceState): Promise<ServiceState> {
  const y = await ctx.store.get<{ at: number }>(yieldKey(ctx.sid));
  if (!y) return state;
  const at = Math.max(state.yieldRequestedAt ?? 0, y.value.at);
  return at === (state.yieldRequestedAt ?? 0) ? state : { ...state, yieldRequestedAt: at };
}

export function jobKey(sid: string, id: string): string {
  return `s/${sid}/job/${id}`;
}

export function jobsIndexKey(sid: string): string {
  return `s/${sid}/jobs`;
}

export async function loadState(ctx: Ctx, now: number): Promise<ServiceState> {
  const cur = await ctx.store.get<ServiceState>(ctx.stateKey);
  if (cur) return cur.value;
  const fresh = initialState(now);
  await ctx.store.set(ctx.stateKey, fresh, { onlyIfNew: true });
  const again = await ctx.store.get<ServiceState>(ctx.stateKey);
  return again ? again.value : fresh;
}

export async function updateState<R>(ctx: Ctx, fn: (cur: ServiceState, now: number) => { value: ServiceState; result: R }) {
  return updateWithCas(ctx.store, ctx.stateKey, () => initialState(Date.now()), (cur) => fn(cur, Date.now()));
}

export interface JevCall<T> {
  readonly answer: T | null;
  readonly tag: DeciderTag;
  readonly latencyMs: number;
  readonly error: string | null;
  readonly gated: string | null;
}

/** Run one Jev call under the budget guard with a hard timeout. Counters are applied by the caller's CAS. */
export async function consultJev<T>(ctx: Ctx, state: ServiceState, now: number, call: (signal: AbortSignal) => Promise<T>): Promise<JevCall<T>> {
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

function applyJevCounters(state: ServiceState, call: JevCall<unknown>, now: number, last: JevLast | null): ServiceState {
  if (call.gated !== null) return state;
  let jev = noteJevCall(state.jev, now);
  jev = call.error === null ? noteJevSuccess(jev) : noteJevError(jev, now);
  if (call.error !== null) jev = { ...jev, lastError: { at: now, message: call.error.slice(0, 200), latencyMs: call.latencyMs } };
  return { ...state, jev: last ? { ...jev, last } : jev };
}

/** Evaluate the window if it is stale, consulting Jev for the stress score when allowed. */
export async function ensureWindow(ctx: Ctx, state: ServiceState, now: number, allowJev = true): Promise<{ state: ServiceState; evaluated: boolean; reasons: readonly string[] }> {
  if (!isWindowStale(state, now)) return { state, evaluated: false, reasons: [] };
  const summary = summarize(state.telemetry, now - WINDOW_MS);
  const previous = summarize(state.telemetry, now - 2 * WINDOW_MS);
  const recent = state.telemetry.slice(-15).map((o) => ({ ok: o.ok, latencyMs: o.latencyMs, timeout: o.timeout }));
  const call = allowJev && summary.n > 0 && state.breaker.state === "CLOSED"
    ? await consultJev(ctx, state, now, (signal) => ctx.decider.stress({ tier: state.tier, summary, previous, recent }, signal))
    : { answer: null, tag: "deterministic" as DeciderTag, latencyMs: 0, error: null, gated: "idle" };
  const last: JevLast | null = call.answer ? { kind: "stress", at: now, latencyMs: call.latencyMs, answers: { stress: call.answer }, decider: "jev" } : null;
  const r = await updateState(ctx, (cur, t) => {
    if (!isWindowStale(cur, t)) return { value: cur, result: { evaluated: false, reasons: [] as readonly string[] } };
    const counted = applyJevCounters(cur, call, t, last);
    const ev = evaluateWindow(counted, t, call.answer ? { score: call.answer.score, confidence: call.answer.confidence } : null, call.tag);
    if (ev.changed) console.info(JSON.stringify({ event: "tier.change", sid: ctx.sid, from: cur.tier, to: ev.state.tier, decider: ev.state.decider, reasons: ev.reasons }));
    return { value: ev.state, result: { evaluated: true, reasons: ev.reasons } };
  });
  return { state: r.value, evaluated: r.result.evaluated, reasons: r.result.reasons };
}

const DEFAULT_CLASS: Omit<ClassCacheEntry, "at" | "decider"> = {
  priority: "standard",
  probabilities: { critical: 0, standard: 1, bulk: 0 },
  confidence: 0,
  safeToRetry: 0,
};

/** Classify a request description, with a per-session cache and the deterministic default on any bypass. */
export async function classify(ctx: Ctx, state: ServiceState, description: string, now: number): Promise<{ entry: ClassCacheEntry; state: ServiceState; cached: boolean }> {
  const h = sha256(description).slice(0, 16);
  const hit = state.classCache[h];
  if (hit && !hit.pending && now - hit.at < JEV_BUDGET.classCacheMs) return { entry: hit, state, cached: true };

  // Claim the miss so concurrent identical requests do not each call Jev. Losers wait briefly for the answer.
  if (!(hit && hit.pending && now - hit.at < CLAIM_TTL_MS)) {
    const claim = await updateState(ctx, (cur, t) => {
      const existing = cur.classCache[h];
      if (existing && ((!existing.pending && t - existing.at < JEV_BUDGET.classCacheMs) || (existing.pending && t - existing.at < CLAIM_TTL_MS))) {
        return { value: cur, result: { won: false, entry: existing } };
      }
      const placeholder: ClassCacheEntry = { ...DEFAULT_CLASS, pending: true, decider: "deterministic", at: t };
      return { value: { ...cur, classCache: { ...cur.classCache, [h]: placeholder } }, result: { won: true, entry: placeholder } };
    });
    state = claim.value;
    if (claim.ok && !claim.result.won) {
      const e = claim.result.entry;
      if (!e.pending) return { entry: e, state, cached: true };
    } else if (claim.ok && claim.result.won) {
      return finishClassification(ctx, state, description, h, now);
    }
  }
  // Someone else holds the claim: poll for their answer, then fall back to the default without spending budget.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const cur = await ctx.store.get<ServiceState>(ctx.stateKey);
    const e = cur?.value.classCache[h];
    if (e && !e.pending) return { entry: e, state: cur ? cur.value : state, cached: true };
  }
  return { entry: { ...DEFAULT_CLASS, decider: "deterministic", at: now }, state, cached: false };
}

const CLAIM_TTL_MS = 2_500;

async function finishClassification(ctx: Ctx, state: ServiceState, description: string, h: string, now: number): Promise<{ entry: ClassCacheEntry; state: ServiceState; cached: boolean }> {
  const call = await consultJev(ctx, state, now, (signal) => ctx.decider.classify(description, signal));
  let entry: ClassCacheEntry;
  if (call.answer) {
    const a = call.answer;
    const confident = a.confidence >= CONFIDENCE_GENERAL;
    entry = {
      priority: confident ? a.priority : "standard",
      probabilities: a.probabilities,
      confidence: a.confidence,
      safeToRetry: a.safeToRetry,
      decider: confident ? "jev" : "jev-bypassed-lowconf",
      at: now,
    };
  } else {
    entry = { ...DEFAULT_CLASS, decider: call.tag, at: now };
  }
  const last: JevLast | null = call.answer ? { kind: "classify", at: now, latencyMs: call.latencyMs, answers: { description, ...call.answer }, decider: entry.decider } : null;
  const r = await updateState(ctx, (cur, t) => {
    const counted = applyJevCounters(cur, call, t, last);
    const keys = Object.keys(counted.classCache);
    const cache: Record<string, ClassCacheEntry> = { ...counted.classCache };
    if (keys.length >= JEV_BUDGET.classCacheMax) {
      const oldest = keys.sort((a, b) => (cache[a]?.at ?? 0) - (cache[b]?.at ?? 0)).slice(0, keys.length - JEV_BUDGET.classCacheMax + 1);
      for (const k of oldest) delete cache[k];
    }
    cache[h] = entry;
    return { value: { ...counted, classCache: cache, updatedAt: t }, result: null };
  });
  return { entry, state: r.value, cached: false };
}

export async function recordUpstream(ctx: Ctx, outcome: Outcome, probe: boolean, counters: Record<string, number> = {}): Promise<ServiceState> {
  const r = await updateState(ctx, (cur, t) => {
    let next: ServiceState = { ...cur, telemetry: recordOutcome(cur.telemetry, outcome), updatedAt: t };
    if (probe) next = applyProbeResult(next, outcome.ok, t);
    const merged: Record<string, number> = { ...next.counters };
    for (const [k, v] of Object.entries(counters)) merged[k] = (merged[k] ?? 0) + v;
    merged[outcome.ok ? "upstreamOk" : "upstreamFail"] = (merged[outcome.ok ? "upstreamOk" : "upstreamFail"] ?? 0) + 1;
    return { value: { ...next, counters: merged }, result: null };
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

export interface SessionEntry {
  readonly sid: string;
  readonly at: number;
}

export async function touchSession(ctx: Ctx, now: number): Promise<void> {
  await updateWithCas<SessionEntry[], null>(ctx.store, SESSIONS_KEY, () => [], (cur) => {
    const others = cur.filter((e) => e.sid !== ctx.sid && now - e.at < 30 * 60_000);
    const next = [...others, { sid: ctx.sid, at: now }].slice(-100);
    return { value: next, result: null };
  }, 2);
}

export async function listJobs(ctx: Ctx): Promise<Job[]> {
  const idx = await ctx.store.get<string[]>(jobsIndexKey(ctx.sid));
  if (!idx) return [];
  const jobs = await Promise.all(idx.value.map((id) => ctx.store.get<Job>(jobKey(ctx.sid, id))));
  return jobs.flatMap((j) => (j ? [j.value] : []));
}

export async function addJobToIndex(ctx: Ctx, id: string): Promise<void> {
  await updateWithCas<string[], null>(ctx.store, jobsIndexKey(ctx.sid), () => [], (cur) => ({ value: [...cur.filter((x) => x !== id), id].slice(-20), result: null }));
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

export async function updateJob(ctx: Ctx, id: string, fn: (job: Job) => Job): Promise<Job | null> {
  const cur = await ctx.store.get<Job>(jobKey(ctx.sid, id));
  if (!cur) return null;
  const r = await updateWithCas<Job, null>(ctx.store, jobKey(ctx.sid, id), () => cur.value, (j) => ({ value: fn(j), result: null }));
  return r.value;
}
