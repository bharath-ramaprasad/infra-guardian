import type { Config, Context } from "@netlify/functions";
import { randomBytes } from "node:crypto";
import { BATCH_CFG, CONFIDENCE_GENERAL, clampTier, createJob, type DeciderTag, type Job } from "../../src/core";
import { badRequest, descriptionOf, json, readJson, sessionId } from "../../src/http";
import { addJobToIndex, consultJev, jobKey, listJobs, loadState, makeCtx, touchSession, updateState } from "../../src/service";

// Submit and list batch jobs. Deferability is scored by Jev at submission (advisory; level 2 on any bypass).

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const sid = sessionId(url);
  if (!sid) return badRequest("pass ?s=<session id, 6-32 chars of [A-Za-z0-9_-]>");
  const ctx = await makeCtx(sid);

  if (req.method === "GET") {
    const jobs = await listJobs(ctx);
    return json(200, { jobs });
  }
  if (req.method !== "POST") return json(405, { error: "use GET or POST" }, { allow: "GET, POST" });

  const body = await readJson(req);
  const description = descriptionOf(body, "batch job");
  const itemsRaw = body && typeof body === "object" && "items" in body ? Number((body as { items?: unknown }).items) : NaN;
  const items = Number.isFinite(itemsRaw) ? Math.min(BATCH_CFG.maxItems, Math.max(1, Math.floor(itemsRaw))) : 200;
  const now = Date.now();
  const state = await loadState(ctx, now);
  const call = await consultJev(ctx, state, now, (signal) => ctx.decider.deferability(description, signal));
  let deferability = 2;
  let confidence = 0;
  let decider: DeciderTag = call.tag;
  if (call.answer) {
    confidence = call.answer.confidence;
    if (confidence >= CONFIDENCE_GENERAL) {
      deferability = clampTier(call.answer.score);
      decider = "jev";
    } else {
      decider = "jev-bypassed-lowconf";
    }
  }
  await updateState(ctx, (cur, t) => {
    if (call.gated !== null) return { value: cur, result: null };
    const jev = { ...cur.jev, minuteBucket: Math.floor(t / 60_000), minuteCount: (cur.jev.minuteBucket === Math.floor(t / 60_000) ? cur.jev.minuteCount : 0) + 1, dayBucket: Math.floor(t / 86_400_000), dayCount: (cur.jev.dayBucket === Math.floor(t / 86_400_000) ? cur.jev.dayCount : 0) + 1, totalCalls: cur.jev.totalCalls + 1, consecutiveErrors: call.error ? cur.jev.consecutiveErrors + 1 : 0 };
    const last = call.answer ? { kind: "deferability" as const, at: t, latencyMs: call.latencyMs, answers: { description, ...call.answer }, decider } : cur.jev.last;
    const lastError = call.error ? { at: t, message: call.error.slice(0, 200), latencyMs: call.latencyMs } : cur.jev.lastError;
    return { value: { ...cur, jev: { ...jev, last, lastError }, updatedAt: t }, result: null };
  });
  const id = randomBytes(4).toString("hex");
  const job: Job = { ...createJob(id, description, items, now), deferability, deferabilityConfidence: confidence, deferabilityDecider: decider };
  await ctx.store.set(jobKey(sid, id), job, { onlyIfNew: true });
  await addJobToIndex(ctx, id);
  await touchSession(ctx, now);
  console.info(JSON.stringify({ event: "job.submitted", sid, id, items, deferability, decider }));
  return json(201, { job, jev: { decider, latencyMs: call.latencyMs, answer: call.answer } }, { "x-decider": decider, "x-jev": ctx.decider.kind });
};

export const config: Config = { path: "/api/jobs" };
