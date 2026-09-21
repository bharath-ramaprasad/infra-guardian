import { describe, expect, it } from "vitest";
import {
  admission,
  advanceCursor,
  cancel,
  createJob,
  initialState,
  markRunning,
  noteWaiting,
  preempt,
  resumeOrder,
  type ServiceState,
} from "../../src/core";

describe("invariant 4: cooperative preemption at chunk boundaries", () => {
  const t0 = 10_000_000;
  const calm: ServiceState = { ...initialState(t0), tierChangedAt: t0 - 60_000 };

  it("starts a queued job when pressure is clear and preempts it when the tier rises", () => {
    const job = markRunning(createJob("j1", "nightly export", 100, t0), t0, false, "calm");
    expect(admission(job, calm, t0).run).toBe(true);
    const stressed: ServiceState = { ...calm, tier: 2 };
    const a = admission(job, stressed, t0 + 1);
    expect(a.run).toBe(false);
    expect(a.reason).toBe("tier");
    expect(a.detail).toMatch(/HARD_THROTTLE/);
    const p = preempt(job, t0 + 1, "tier", 0.5, a.detail);
    expect(p.state).toBe("PREEMPTED");
    expect(p.cursor).toBe(job.cursor);
    expect(p.resumeAfter).toBe(t0 + 1 + 250);
    expect(p.history[p.history.length - 1]?.detail).toMatch(/at cursor 0: tier 2 HARD_THROTTLE/);
  });

  it("preempts on the yield flag and on an empty critical pool", () => {
    const job = markRunning(createJob("j2", "export", 100, t0), t0, false, "calm");
    expect(admission(job, { ...calm, yieldRequestedAt: t0 - 500 }, t0).reason).toBe("yield");
    expect(admission(job, { ...calm, yieldRequestedAt: t0 - 5_000 }, t0).run).toBe(true);
    expect(admission(job, { ...calm, pools: { ...calm.pools, critical: 0.5 } }, t0).reason).toBe("critical-reserve");
    expect(admission(job, { ...calm, pools: { ...calm.pools, critical: 4.9 } }, t0).reason).toBe("critical-reserve");
    expect(admission(job, { ...calm, pools: { ...calm.pools, critical: 5 } }, t0).run).toBe(true);
  });

  it("resumes only after a full calm window and the stagger, from the saved cursor", () => {
    const running = advanceCursor(markRunning(createJob("j3", "export", 100, t0), t0, false, "calm"), 35, t0, false);
    const parked = preempt(running, t0, "tier", 1, "tier");
    expect(admission(parked, { ...calm, tierChangedAt: t0 - 1_000 }, t0 + 600).reason).toBe("resume-wait");
    expect(admission(parked, { ...calm, tierChangedAt: t0 - 6_000 }, t0 + 100).reason).toBe("resume-wait");
    const a = admission(parked, { ...calm, tierChangedAt: t0 - 6_000 }, t0 + 600);
    expect(a.run).toBe(true);
    const resumed = markRunning(parked, t0 + 600, true, a.detail);
    expect(resumed.cursor).toBe(35);
    expect(resumed.resumes).toBe(1);
  });

  it("aging guard grants one chunk under pressure, but never while the breaker is open", () => {
    const parked = preempt(markRunning(createJob("j4", "export", 100, t0), t0, false, "calm"), t0, "tier", 0, "tier");
    const stressed: ServiceState = { ...calm, tier: 2 };
    expect(admission(parked, stressed, t0 + 9_000).run).toBe(false);
    const aged = admission(parked, stressed, t0 + 10_000);
    expect(aged.run).toBe(true);
    expect(aged.aging).toBe(true);
    expect(aged.detail).toMatch(/aging guard: 10 s without progress/);
    const granted = advanceCursor(parked, 5, t0 + 10_000, true, aged.detail);
    expect(granted.agingChunks).toBe(1);
    expect(granted.history[granted.history.length - 1]?.event).toBe("aging-chunk");
    expect(granted.history[granted.history.length - 1]?.detail).toMatch(/cursor 0 → 5/);
    expect(admission(parked, { ...calm, tier: 4 }, t0 + 10_000).run).toBe(false);
  });

  it("cursor only moves forward and completes exactly once", () => {
    let job = markRunning(createJob("j5", "export", 12, t0), t0, false, "calm");
    job = advanceCursor(job, 5, t0 + 1, false);
    job = advanceCursor(job, 5, t0 + 2, false);
    expect(job.state).toBe("RUNNING");
    job = advanceCursor(job, 5, t0 + 3, false);
    expect(job.cursor).toBe(12);
    expect(job.state).toBe("DONE");
    expect(job.history[job.history.length - 1]?.event).toBe("done");
    expect(cancel(job, t0 + 4).state).toBe("DONE");
    const failed = advanceCursor(markRunning(createJob("j6", "export", 10, t0), t0, false, "calm"), 0, t0 + 1, false);
    expect(failed.cursor).toBe(0);
    expect(failed.chunksFailed).toBe(1);
    expect(failed.history[failed.history.length - 1]?.event).toBe("chunk-failed");
  });

  it("records a waiting reason once per reason change, not per poll", () => {
    let job = createJob("j7", "export", 10, t0);
    job = noteWaiting(job, t0, "yield", "a critical request raised the yield flag");
    job = noteWaiting(job, t0 + 1000, "yield", "still raised");
    expect(job.history.filter((h) => h.event === "waiting")).toHaveLength(1);
    job = noteWaiting(job, t0 + 2000, "resume-wait", "pressure clear for 1 s");
    expect(job.history.filter((h) => h.event === "waiting")).toHaveLength(2);
    expect(job.waiting?.reason).toBe("resume-wait");
  });

  it("resumes least deferrable first", () => {
    const a = { ...createJob("a", "", 10, 1), deferability: 3 };
    const b = { ...createJob("b", "", 10, 2), deferability: 0 };
    const c = { ...createJob("c", "", 10, 0), deferability: 3 };
    expect(resumeOrder([a, b, c]).map((j) => j.id)).toEqual(["b", "c", "a"]);
  });
});
