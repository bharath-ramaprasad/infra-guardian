import {
  BATCH_CFG,
  CRITICAL_RESERVE_SHARE,
  TIER_NAMES,
  WINDOW_MS,
  YIELD_TTL_MS,
  poolCapacity,
  tierSpec,
  type Job,
  type JobEvent,
  type ServiceState,
} from "./types";

// Cooperative preemption at chunk boundaries. The cursor is the checkpoint; it only ever moves forward.

export type PreemptReason = "tier" | "critical-reserve" | "yield";

/** True when the critical pool has dropped below its reserve share (or is empty). */
export function criticalUnderReserve(state: ServiceState): boolean {
  const cap = poolCapacity(state.tier, "critical");
  return cap === 0 || state.pools.critical < Math.max(1, cap * CRITICAL_RESERVE_SHARE);
}

export function yieldActive(state: ServiceState, now: number): boolean {
  return state.yieldRequestedAt !== null && now - state.yieldRequestedAt < YIELD_TTL_MS;
}

export function preemptReason(state: ServiceState, now: number): PreemptReason | null {
  if (state.tier >= 2) return "tier";
  if (criticalUnderReserve(state)) return "critical-reserve";
  if (yieldActive(state, now)) return "yield";
  return null;
}

export function pressureClear(state: ServiceState, now: number): boolean {
  return state.tier <= 1 && now - state.tierChangedAt >= WINDOW_MS && !yieldActive(state, now);
}

export function agingDue(job: Job, now: number): boolean {
  const last = job.lastChunkAt ?? job.submittedAt;
  return now - last >= BATCH_CFG.agingMs;
}

export function createJob(id: string, description: string, items: number, now: number): Job {
  const n = Math.max(1, Math.min(BATCH_CFG.maxItems, Math.floor(items)));
  return {
    id,
    description: description.slice(0, 500),
    items: n,
    cursor: 0,
    chunkSize: BATCH_CFG.chunkSize,
    state: "QUEUED",
    deferability: 2,
    deferabilityConfidence: 0,
    deferabilityDecider: "deterministic",
    deferabilityText: "",
    submittedAt: now,
    startedAt: null,
    finishedAt: null,
    resumeAfter: null,
    lastChunkAt: null,
    resumes: 0,
    preemptions: 0,
    agingChunks: 0,
    chunksDone: 0,
    chunksFailed: 0,
    waiting: null,
    history: [],
    updatedAt: now,
  };
}

/** One line on what the guard sees right now, used in job events so a reviewer can read why. */
export function pressureDetail(state: ServiceState, now: number): string {
  const cap = poolCapacity(state.tier, "critical");
  const reserve = Math.max(1, cap * CRITICAL_RESERVE_SHARE);
  const parts = [
    `tier ${state.tier} ${TIER_NAMES[state.tier]}`,
    `critical pool ${state.pools.critical.toFixed(1)}/${cap} (reserve ${reserve})`,
  ];
  if (state.yieldRequestedAt !== null && yieldActive(state, now))
    parts.push(`yield flag raised ${((now - state.yieldRequestedAt) / 1000).toFixed(1)} s ago by a critical request`);
  else parts.push("no yield flag");
  return parts.join(", ");
}

export function reasonText(reason: PreemptReason, state: ServiceState): string {
  switch (reason) {
    case "tier":
      return `tier ${state.tier} ${TIER_NAMES[state.tier]} is HARD_THROTTLE or above, batch gets 0 chunks/s`;
    case "critical-reserve":
      return `critical pool ${state.pools.critical.toFixed(1)} is under its ${Math.round(CRITICAL_RESERVE_SHARE * 100)}% reserve, critical requests need the headroom`;
    case "yield":
      return "a critical request could not be admitted promptly and raised the yield flag";
  }
}

function withEvent(job: Job, ev: JobEvent): Job {
  const history = [...job.history, ev];
  return { ...job, history: history.length > 60 ? history.slice(history.length - 60) : history, updatedAt: ev.at };
}

export function noteQueued(job: Job, now: number, detail: string): Job {
  return withEvent(job, { at: now, event: "queued", detail });
}

/** Record why a parked job is still parked. Only writes when the reason changes so polling does not spam history. */
export function noteWaiting(job: Job, now: number, reason: string, detail: string): Job {
  if (job.waiting && job.waiting.reason === reason) return job;
  const next: Job = { ...job, waiting: { at: now, reason, detail } };
  return withEvent(next, { at: now, event: "waiting", detail: `${reason}: ${detail}` });
}

export interface BatchAdmission {
  readonly run: boolean;
  readonly aging: boolean;
  readonly reason: PreemptReason | "resume-wait" | "done" | "cancelled" | null;
  readonly detail: string;
}

/** Decide whether this job may process a chunk right now, and whether it is an aging-guard chunk. */
export function admission(job: Job, state: ServiceState, now: number): BatchAdmission {
  if (job.state === "DONE") return { run: false, aging: false, reason: "done", detail: "job is complete" };
  if (job.state === "CANCELLED") return { run: false, aging: false, reason: "cancelled", detail: "job was cancelled" };
  const reason = preemptReason(state, now);
  const seen = pressureDetail(state, now);
  if (reason === null) {
    if (job.state === "RUNNING") return { run: true, aging: false, reason: null, detail: seen };
    if (job.state === "QUEUED" || pressureClear(state, now)) {
      if (job.resumeAfter !== null && now < job.resumeAfter) {
        return {
          run: false,
          aging: false,
          reason: "resume-wait",
          detail: `resume stagger, ${job.resumeAfter - now} ms left so parked jobs do not all restart at once`,
        };
      }
      return { run: true, aging: false, reason: null, detail: seen };
    }
    const calmFor = ((now - state.tierChangedAt) / 1000).toFixed(1);
    return {
      run: false,
      aging: false,
      reason: "resume-wait",
      detail: `pressure clear but only for ${calmFor} s at ${TIER_NAMES[state.tier]}; a full ${WINDOW_MS / 1000} s window is required before resuming`,
    };
  }
  if (state.tier < 4 && agingDue(job, now)) {
    const idle = ((now - (job.lastChunkAt ?? job.submittedAt)) / 1000).toFixed(0);
    return {
      run: true,
      aging: true,
      reason: null,
      detail: `aging guard: ${idle} s without progress under pressure (${reasonText(reason, state)}); one chunk granted so the job cannot starve`,
    };
  }
  return { run: false, aging: false, reason, detail: reasonText(reason, state) };
}

export function markRunning(job: Job, now: number, resumed: boolean, detail: string): Job {
  const next: Job = {
    ...job,
    state: "RUNNING",
    resumeAfter: null,
    waiting: null,
    startedAt: job.startedAt ?? now,
    resumes: resumed ? job.resumes + 1 : job.resumes,
  };
  return withEvent(next, { at: now, event: resumed ? "resumed" : "started", detail: `at cursor ${job.cursor}; ${detail}` });
}

export function preempt(job: Job, now: number, reason: PreemptReason, stagger: number, detail: string): Job {
  const staggerMs = Math.floor(Math.max(0, Math.min(1, stagger)) * BATCH_CFG.resumeStaggerMaxMs);
  const next: Job = { ...job, state: "PREEMPTED", resumeAfter: now + staggerMs, waiting: null, preemptions: job.preemptions + 1 };
  return withEvent(next, {
    at: now,
    event: "preempted",
    detail: `at cursor ${job.cursor}: ${detail}; will resume from here once pressure is clear for a full window (+${staggerMs} ms stagger)`,
  });
}

export function advanceCursor(job: Job, processed: number, now: number, aging: boolean, detail = ""): Job {
  const cursor = Math.min(job.items, job.cursor + Math.max(0, processed));
  const done = cursor >= job.items;
  const failed = processed <= 0;
  const next: Job = {
    ...job,
    cursor,
    lastChunkAt: now,
    state: done ? "DONE" : job.state,
    finishedAt: done ? now : job.finishedAt,
    chunksDone: job.chunksDone + (failed ? 0 : 1),
    chunksFailed: job.chunksFailed + (failed ? 1 : 0),
    agingChunks: job.agingChunks + (aging ? 1 : 0),
    updatedAt: now,
  };
  let out = next;
  if (failed)
    out = withEvent(out, {
      at: now,
      event: "chunk-failed",
      detail: `upstream failed, cursor stays at ${cursor}; the chunk will be retried`,
    });
  if (aging) out = withEvent(out, { at: now, event: "aging-chunk", detail: `${detail}; cursor ${job.cursor} → ${cursor}` });
  if (done)
    out = withEvent(out, {
      at: now,
      event: "done",
      detail: `${cursor}/${job.items} items, ${job.preemptions} preemption(s), ${job.resumes} resume(s), ${job.agingChunks + (aging ? 1 : 0)} aging chunk(s)`,
    });
  return out;
}

export function cancel(job: Job, now: number): Job {
  if (job.state === "DONE" || job.state === "CANCELLED") return job;
  return withEvent({ ...job, state: "CANCELLED" }, { at: now, event: "cancelled" });
}

export function chunksPerStep(state: ServiceState): number {
  const rate = tierSpec(state.tier).batchChunksPerSec;
  return Math.max(1, Math.floor((rate * BATCH_CFG.stepBudgetMs) / 1000));
}

/** Resume order: least deferrable first, then oldest. */
export function resumeOrder(jobs: readonly Job[]): Job[] {
  return [...jobs].sort((a, b) => a.deferability - b.deferability || a.submittedAt - b.submittedAt);
}
