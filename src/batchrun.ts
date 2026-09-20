import { BATCH_CFG, admission, advanceCursor, chunksPerStep, markRunning, preempt, tierSpec, type Job, type Outcome, type ServiceState } from "./core";
import { sleep } from "./http";
import { ensureWindow, jobKey, loadState, recordBatchOutcomes, updateJob, withYield, type Ctx } from "./service";
import { callUpstream, type UpstreamParams } from "./upstream";

// One step of a batch job: process chunks until the step budget is spent, the job finishes, or a preemption
// condition appears. The preempt check runs before every chunk against a fresh read of the service state.

export interface StepResult {
  readonly job: Job | null;
  readonly state: ServiceState;
  readonly chunks: number;
  readonly stopReason: string;
}

export const DEFAULT_BATCH_PARAMS: UpstreamParams = { fail: 0, latency: 120, tail: 0 };

export async function stepJob(ctx: Ctx, id: string, params: UpstreamParams, budgetMs: number, allowJev = true): Promise<StepResult> {
  const t0 = Date.now();
  let state = await loadState(ctx, t0);
  state = (await ensureWindow(ctx, state, Date.now(), allowJev)).state;
  state = await withYield(ctx, state);
  const cur = await ctx.store.get<Job>(jobKey(ctx.sid, id));
  if (!cur) return { job: null, state, chunks: 0, stopReason: "not-found" };
  let job = cur.value;
  const outcomes: Outcome[] = [];
  let chunks = 0;
  let stopReason = "budget";
  const maxChunks = Math.max(1, chunksPerStep(state));

  while (Date.now() - t0 < budgetMs && chunks < maxChunks) {
    const now = Date.now();
    if (chunks > 0) {
      const fresh = await ctx.store.get<ServiceState>(ctx.stateKey);
      if (fresh) state = await withYield(ctx, fresh.value);
    }
    const a = admission(job, state, now);
    if (!a.run) {
      if (job.state === "RUNNING" && (a.reason === "tier" || a.reason === "critical-reserve" || a.reason === "yield")) {
        const reason = a.reason;
        job = (await updateJob(ctx, id, (j) => preempt(j, now, reason, Math.random()))) ?? job;
        console.info(JSON.stringify({ event: "job.preempted", sid: ctx.sid, id, reason, cursor: job.cursor }));
        stopReason = `preempted:${reason}`;
      } else {
        stopReason = a.reason ?? "parked";
      }
      break;
    }
    if (job.state !== "RUNNING") {
      const resumed = job.state === "PREEMPTED";
      job = (await updateJob(ctx, id, (j) => markRunning(j, now, resumed))) ?? job;
    }
    const chunkStart = Date.now();
    const r = await callUpstream({ ...params, latency: Math.min(params.latency, BATCH_CFG.chunkMs) });
    outcomes.push({ ok: r.ok, latencyMs: Date.now() - chunkStart, timeout: r.timeout, at: Date.now() });
    const processed = r.ok ? job.chunkSize : 0;
    const aging = a.aging;
    job = (await updateJob(ctx, id, (j) => advanceCursor(j, processed, Date.now(), aging))) ?? job;
    chunks++;
    if (aging) {
      stopReason = "aging-chunk";
      break;
    }
    if (job.state === "DONE") {
      stopReason = "done";
      break;
    }
    const interval = 1000 / Math.max(1, tierSpec(state.tier).batchChunksPerSec);
    const elapsed = Date.now() - chunkStart;
    if (interval > elapsed) await sleep(interval - elapsed);
  }
  if (outcomes.length > 0) state = await recordBatchOutcomes(ctx, outcomes);
  return { job, state, chunks, stopReason };
}
