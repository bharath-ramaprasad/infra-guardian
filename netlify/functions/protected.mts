import type { Config, Context } from "@netlify/functions";
import { TIER_NAMES, WAIT_BUDGET_MS, decideAdmission, waitBudgetMs, type Admission, type ClassCacheEntry, type Outcome, type ServiceState } from "../../src/core";
import { badRequest, descriptionOf, flag, idempotencyKeyOf, json, readJson, sessionId, sleep } from "../../src/http";
import { classify, ensureWindow, loadState, makeCtx, raiseYield, recordUpstream, touchSession, updateState, type Ctx } from "../../src/service";
import { explainAdmission, explainClass, explainTier, explainUpstream } from "../../src/explain";
import { runHedged } from "../../src/hedgerun";
import { clampUpstreamParams } from "../../src/upstream";

// The guarded endpoint. Every response explains itself in headers (docs/data-plane.md §5).

function headersFor(ctx: Ctx, state: ServiceState, cls: ClassCacheEntry, waited: number, extra: Record<string, string>): Record<string, string> {
  return {
    "x-tier": `${state.tier} ${TIER_NAMES[state.tier]}`,
    "x-breaker": state.breaker.state.toLowerCase().replace("_", "-"),
    "x-decider": cls.decider,
    "x-priority": `${cls.priority} p=${(cls.probabilities[cls.priority] ?? 0).toFixed(2)}`,
    "x-wait-ms": String(waited),
    "x-ratelimit-remaining": String(Math.max(0, Math.floor(state.pools[cls.priority]))),
    "x-store": ctx.degraded ? "degraded" : "ok",
    "x-jev": ctx.decider.kind,
    ...extra,
  };
}

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const sid = sessionId(url);
  if (!sid) return badRequest("pass ?s=<session id, 6-32 chars of [A-Za-z0-9_-]>");
  if (req.method !== "POST" && req.method !== "GET") return json(405, { error: "use GET or POST" }, { allow: "GET, POST" });

  const t0 = Date.now();
  const ctx = await makeCtx(sid);
  const body = req.method === "POST" ? await readJson(req) : null;
  const description = descriptionOf(body, `${req.method} /api/protected`);
  const idempotent = req.method === "GET" || idempotencyKeyOf(req, body) !== null;
  const params = clampUpstreamParams({ fail: url.searchParams.get("fail"), latency: url.searchParams.get("latency"), tail: url.searchParams.get("tail") });
  const hedgeEnabled = flag(url, "hedge", true);

  let state = await loadState(ctx, t0);
  const win = await ensureWindow(ctx, state, Date.now());
  state = win.state;
  if (win.evaluated) await touchSession(ctx, Date.now());
  const c = await classify(ctx, state, description, Date.now());
  state = c.state;
  const cls = c.entry;
  const budget = cls.decider === "jev" ? waitBudgetMs(cls.probabilities) : WAIT_BUDGET_MS.standard;

  const waitStart = Date.now();
  let waited = 0;
  let admission: Admission | null = null;
  let contention = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = await updateState(ctx, (cur, now) => {
      const a = decideAdmission({ state: cur, now, cls, idempotent, hedgeEnabled });
      return { value: a.state, result: a };
    });
    admission = r.result;
    state = r.value;
    contention = !r.ok;
    if (admission.kind !== "reject" || contention) break;
    const remaining = budget - waited;
    if (remaining <= 0) break;
    await sleep(Math.min(remaining, Math.max(25, admission.retryAfterMs)));
    waited = Date.now() - waitStart;
  }
  if (!admission) return json(500, { error: "no admission decision" });

  // Critical demand that could not be served promptly is pressure: batch work must step aside.
  const yieldNow = cls.priority === "critical" && (contention || admission.kind === "reject" || (admission.kind === "admit" && admission.state.yieldRequestedAt !== null && Date.now() - admission.state.yieldRequestedAt < 1000));
  if (yieldNow) await raiseYield(ctx, Date.now());

  const nowForWhy = Date.now();
  const whyBase = [...explainClass(cls), ...explainAdmission(state, admission, cls, waited, budget, contention, nowForWhy)];
  const decisionBase = { tier: state.tier, tierName: TIER_NAMES[state.tier], breaker: state.breaker.state, priority: cls.priority, probabilities: cls.probabilities, confidence: cls.confidence, safeToRetry: cls.safeToRetry, decider: cls.decider, classified: c.cached ? "cache" : ctx.decider.kind, waitedMs: waited, waitBudgetMs: budget };
  if (contention) {
    return json(429, { ok: false, error: "contention", retryAfterMs: 1000, decision: { ...decisionBase, hedge: "off" }, why: whyBase, state: explainTier(state, nowForWhy) }, headersFor(ctx, state, cls, waited, { "x-hedge": "off", "x-ratelimit-reason": "contention", "retry-after": "1" }));
  }
  if (admission.kind === "fail-fast") {
    const secs = Math.max(1, Math.ceil(admission.retryAfterMs / 1000));
    return json(503, { ok: false, error: "circuit-open", retryAfterMs: admission.retryAfterMs, waitedMs: waited, decision: { ...decisionBase, hedge: "off" }, why: whyBase, state: explainTier(state, nowForWhy) }, headersFor(ctx, state, cls, waited, { "x-hedge": "off", "x-ratelimit-reason": "circuit-open", "retry-after": String(secs) }));
  }
  if (admission.kind === "reject") {
    const secs = Math.max(1, Math.ceil(admission.retryAfterMs / 1000));
    return json(admission.status, { ok: false, error: admission.reason, retryAfterMs: admission.retryAfterMs, waitedMs: waited, waitBudgetMs: budget, decision: { ...decisionBase, hedge: "off" }, why: whyBase, state: explainTier(state, nowForWhy) }, headersFor(ctx, state, cls, waited, { "x-hedge": "off", "x-ratelimit-reason": admission.reason, "retry-after": String(secs) }));
  }

  const probe = admission.kind === "probe";
  const hedge = admission.kind === "admit" ? admission.hedge : null;
  const run = await runHedged(params, probe ? null : hedge);
  const outcome: Outcome = { ok: run.result.ok, latencyMs: run.elapsedMs, timeout: run.result.timeout, at: Date.now() };
  state = await recordUpstream(ctx, outcome, probe, { admitted: 1, hedgeFired: run.fired ? 1 : 0, [`class_${cls.priority}`]: 1 });

  const status = run.result.ok ? 200 : run.result.timeout ? 504 : 502;
  return json(
    status,
    {
      ok: run.result.ok,
      ...(run.result.ok ? {} : { error: run.result.timeout ? "upstream-timeout" : "upstream-error" }),
      upstream: { latencyMs: run.elapsedMs, timeout: run.result.timeout, params },
      decision: { ...decisionBase, hedge: run.hedgeHeader, probe, totalMs: Date.now() - t0 },
      why: [...whyBase, ...explainUpstream(run.result, run.elapsedMs, params, run.hedgeHeader, probe)],
      state: explainTier(state, Date.now()),
    },
    headersFor(ctx, state, cls, waited, { "x-hedge": run.hedgeHeader, "x-upstream": run.result.ok ? "ok" : run.result.timeout ? "timeout" : "error", "x-probe": probe ? "1" : "0" }),
  );
};

export const config: Config = { path: "/api/protected" };
