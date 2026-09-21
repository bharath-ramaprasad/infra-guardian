import {
  BATCH_CFG,
  CRITICAL_RESERVE_SHARE,
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
    submittedAt: now,
    resumeAfter: null,
    lastChunkAt: null,
    resumes: 0,
    preemptions: 0,
    history: [{ at: now, event: "submitted" }],
    updatedAt: now,
  };
}

function withEvent(job: Job, ev: JobEvent): Job {
  const history = [...job.history, ev];
  return { ...job, history: history.length > 40 ? history.slice(history.length - 40) : history, updatedAt: ev.at };
}

/** Decide whether this job may process a chunk right now, and whether it is an aging-guard chunk. */
export function admission(
  job: Job,
  state: ServiceState,
  now: number,
): { run: boolean; aging: boolean; reason: PreemptReason | "resume-wait" | "done" | "cancelled" | null } {
  if (job.state === "DONE") return { run: false, aging: false, reason: "done" };
  if (job.state === "CANCELLED") return { run: false, aging: false, reason: "cancelled" };
  const reason = preemptReason(state, now);
  if (reason === null) {
    if (job.state === "RUNNING") return { run: true, aging: false, reason: null };
    // QUEUED or PREEMPTED: resume only when pressure has been clear for a full window (QUEUED may start at once).
    if (job.state === "QUEUED" || pressureClear(state, now)) {
      if (job.resumeAfter !== null && now < job.resumeAfter) return { run: false, aging: false, reason: "resume-wait" };
      return { run: true, aging: false, reason: null };
    }
    return { run: false, aging: false, reason: "resume-wait" };
  }
  // Under pressure: the aging guard grants one chunk unless the breaker is open.
  if (state.tier < 4 && agingDue(job, now)) return { run: true, aging: true, reason: null };
  return { run: false, aging: false, reason };
}

export function markRunning(job: Job, now: number, resumed: boolean): Job {
  const next: Job = { ...job, state: "RUNNING", resumeAfter: null, resumes: resumed ? job.resumes + 1 : job.resumes };
  return withEvent(next, { at: now, event: resumed ? "resumed" : "started", detail: `cursor ${job.cursor}` });
}

export function preempt(job: Job, now: number, reason: PreemptReason, stagger: number): Job {
  const resumeAfter = now + Math.floor(Math.max(0, Math.min(1, stagger)) * BATCH_CFG.resumeStaggerMaxMs);
  const next: Job = { ...job, state: "PREEMPTED", resumeAfter, preemptions: job.preemptions + 1 };
  return withEvent(next, { at: now, event: "preempted", detail: `${reason} at cursor ${job.cursor}` });
}

export function advanceCursor(job: Job, processed: number, now: number, aging: boolean): Job {
  const cursor = Math.min(job.items, job.cursor + Math.max(0, processed));
  const done = cursor >= job.items;
  const next: Job = { ...job, cursor, lastChunkAt: now, state: done ? "DONE" : job.state, updatedAt: now };
  if (done) return withEvent(next, { at: now, event: "done" });
  return aging ? withEvent(next, { at: now, event: "aging-chunk", detail: `cursor ${cursor}` }) : next;
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
