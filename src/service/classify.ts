import { CONFIDENCE_GENERAL, JEV_BUDGET, type ClassCacheEntry, type JevLast, type ServiceState } from "../core";
import { sha256 } from "../http";
import { updateState, type Ctx } from "./context";
import { applyJevCounters, consultJev } from "./jev";

// Request classification with a per-session cache. A miss is claimed so a burst of identical requests
// results in one Jev call; losers wait briefly for the answer and never spend budget.

export interface Classification {
  readonly entry: ClassCacheEntry;
  readonly state: ServiceState;
  readonly cached: boolean;
}

const CLAIM_TTL_MS = 2_500;

const DEFAULT_CLASS: Omit<ClassCacheEntry, "at" | "decider"> = {
  priority: "standard",
  probabilities: { critical: 0, standard: 1, bulk: 0 },
  confidence: 0,
  safeToRetry: 0,
};

export async function classify(ctx: Ctx, state: ServiceState, description: string, now: number): Promise<Classification> {
  const h = sha256(description).slice(0, 16);
  const hit = state.classCache[h];
  if (hit && !hit.pending && now - hit.at < JEV_BUDGET.classCacheMs) return { entry: hit, state, cached: true };

  if (!(hit && hit.pending && now - hit.at < CLAIM_TTL_MS)) {
    const claim = await updateState(ctx, (cur, t) => {
      const existing = cur.classCache[h];
      if (
        existing &&
        ((!existing.pending && t - existing.at < JEV_BUDGET.classCacheMs) || (existing.pending && t - existing.at < CLAIM_TTL_MS))
      ) {
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
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const cur = await ctx.store.get<ServiceState>(ctx.stateKey);
    const e = cur?.value.classCache[h];
    if (e && !e.pending) return { entry: e, state: cur ? cur.value : state, cached: true };
  }
  return { entry: { ...DEFAULT_CLASS, decider: "deterministic", at: now }, state, cached: false };
}

async function finishClassification(ctx: Ctx, state: ServiceState, description: string, h: string, now: number): Promise<Classification> {
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
  const last: JevLast | null = call.answer
    ? { kind: "classify", at: now, latencyMs: call.latencyMs, answers: { description, ...call.answer }, decider: entry.decider }
    : null;
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
