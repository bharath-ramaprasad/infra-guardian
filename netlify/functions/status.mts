import type { Config, Context } from "@netlify/functions";
import { JEV_BUDGET, TIER_NAMES, WINDOW_MS, cooldownRemainingMs, summarize, tierSpec, yieldActive } from "../../src/core";
import { badRequest, json, sessionId } from "../../src/http";
import { explainTier } from "../../src/service";
import { ensureWindow, listJobs, loadState, makeCtx, withYield } from "../../src/service";

// Everything a reviewer needs to see the system reasoning, from curl alone.

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const sid = sessionId(url);
  if (!sid) return badRequest("pass ?s=<session id, 6-32 chars of [A-Za-z0-9_-]>");
  const now = Date.now();
  const ctx = await makeCtx(sid);
  let state = await loadState(ctx, now);
  state = await withYield(ctx, (await ensureWindow(ctx, state, Date.now())).state);
  const jobs = await listJobs(ctx);
  const spec = tierSpec(state.tier);
  const last = summarize(state.telemetry, now - WINDOW_MS);
  const recent = summarize(state.telemetry, now - 10 * WINDOW_MS);
  const cache = Object.values(state.classCache)
    .sort((a, b) => b.at - a.at)
    .slice(0, 8);
  return json(
    200,
    {
      session: sid,
      now,
      store: ctx.degraded ? "degraded" : ctx.store.kind,
      jevBackend: ctx.decider.kind,
      tier: state.tier,
      tierName: TIER_NAMES[state.tier],
      tierSince: state.tierChangedAt,
      tierSpec: spec,
      tierHistory: state.tierHistory,
      lastEvaluation: state.lastEvaluation,
      explain: explainTier(state, now),
      breaker: {
        state: state.breaker.state,
        cooldownMs: state.breaker.cooldownMs,
        cooldownRemainingMs: cooldownRemainingMs(state.breaker, now),
        probeInFlight: state.breaker.probeStartedAt !== null,
      },
      pools: { critical: +state.pools.critical.toFixed(2), standard: +state.pools.standard.toFixed(2), bulk: +state.pools.bulk.toFixed(2) },
      window: { id: state.window, cleanWindows: state.cleanWindows, last, recent },
      yieldActive: yieldActive(state, now),
      decider: state.decider,
      lastStress: state.lastStress,
      jev: {
        off: state.jev.off,
        minuteCount: state.jev.minuteCount,
        dayCount: state.jev.dayCount,
        totalCalls: state.jev.totalCalls,
        consecutiveErrors: state.jev.consecutiveErrors,
        innerBreakerOpenUntil: state.jev.openUntil,
        last: state.jev.last,
        lastError: state.jev.lastError,
        timeoutMs: JEV_BUDGET.timeoutMs,
      },
      classifications: cache,
      counters: state.counters,
      jobs: jobs.map((j) => ({
        id: j.id,
        description: j.description,
        items: j.items,
        cursor: j.cursor,
        state: j.state,
        deferability: j.deferability,
        deferabilityConfidence: j.deferabilityConfidence,
        deferabilityDecider: j.deferabilityDecider,
        preemptions: j.preemptions,
        resumes: j.resumes,
        resumeAfter: j.resumeAfter,
        lastEvent: j.history[j.history.length - 1] ?? null,
      })),
      telemetry: state.telemetry.slice(-20),
    },
    {
      "x-tier": `${state.tier} ${TIER_NAMES[state.tier]}`,
      "x-breaker": state.breaker.state.toLowerCase().replace("_", "-"),
      "x-decider": state.decider,
      "x-store": ctx.degraded ? "degraded" : "ok",
    },
  );
};

export const config: Config = { path: "/api/status" };
