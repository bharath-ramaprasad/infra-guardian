import type { Config, Context } from "@netlify/functions";
import { BATCH_CFG, TIER_NAMES, cancel } from "../../src/core";
import { badRequest, json, sessionId } from "../../src/http";
import { stepJob } from "../../src/service";
import { jobKey, makeCtx, updateJob } from "../../src/service";
import { clampUpstreamParams } from "../../src/upstream";
import type { Job } from "../../src/core";

// GET /api/jobs/:id, POST /api/jobs/:id/step, POST /api/jobs/:id/cancel

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const sid = sessionId(url);
  if (!sid) return badRequest("pass ?s=<session id, 6-32 chars of [A-Za-z0-9_-]>");
  const id = context.params.id ?? "";
  if (!/^[a-f0-9]{8}$/.test(id)) return badRequest("invalid job id");
  const ctx = await makeCtx(sid);
  const action = url.pathname.endsWith("/step") ? "step" : url.pathname.endsWith("/cancel") ? "cancel" : "get";

  if (action === "get") {
    const cur = await ctx.store.get<Job>(jobKey(sid, id));
    return cur ? json(200, { job: cur.value }, { "x-job": cur.value.state.toLowerCase() }) : json(404, { error: "not found" });
  }
  if (req.method !== "POST") return json(405, { error: "use POST" }, { allow: "POST" });

  if (action === "cancel") {
    const job = await updateJob(ctx, id, (j) => cancel(j, Date.now()));
    return job ? json(200, { job }, { "x-job": job.state.toLowerCase() }) : json(404, { error: "not found" });
  }

  const params = clampUpstreamParams({
    fail: url.searchParams.get("fail"),
    latency: url.searchParams.get("latency"),
    tail: url.searchParams.get("tail"),
  });
  const r = await stepJob(ctx, id, params, BATCH_CFG.stepBudgetMs);
  if (!r.job) return json(404, { error: "not found" });
  return json(
    200,
    { job: r.job, step: { chunks: r.chunks, stopReason: r.stopReason }, tier: r.state.tier, tierName: TIER_NAMES[r.state.tier] },
    {
      "x-job": r.job.state.toLowerCase(),
      "x-tier": `${r.state.tier} ${TIER_NAMES[r.state.tier]}`,
      "x-breaker": r.state.breaker.state.toLowerCase().replace("_", "-"),
      "x-step-stop": r.stopReason,
      "x-store": ctx.degraded ? "degraded" : "ok",
    },
  );
};

export const config: Config = { path: ["/api/jobs/:id", "/api/jobs/:id/step", "/api/jobs/:id/cancel"] };
