import { describe, expect, it } from "vitest";
import { admission, advanceCursor, cancel, createJob, initialState, markRunning, preempt, resumeOrder, type ServiceState } from "../src/core";

describe("invariant 4: cooperative preemption at chunk boundaries", () => {
  const t0 = 10_000_000;
  const calm: ServiceState = { ...initialState(t0), tierChangedAt: t0 - 60_000 };

  it("starts a queued job when pressure is clear and preempts it when the tier rises", () => {
    const job = markRunning(createJob("j1", "nightly export", 100, t0), t0, false);
    expect(admission(job, calm, t0).run).toBe(true);
    const stressed: ServiceState = { ...calm, tier: 2 };
    const a = admission(job, stressed, t0 + 1);
    expect(a.run).toBe(false);
    expect(a.reason).toBe("tier");
    const p = preempt(job, t0 + 1, "tier", 0.5);
    expect(p.state).toBe("PREEMPTED");
    expect(p.cursor).toBe(job.cursor);
    expect(p.resumeAfter).toBe(t0 + 1 + 250);
  });

  it("preempts on the yield flag and on an empty critical pool", () => {
    const job = markRunning(createJob("j2", "export", 100, t0), t0, false);
    expect(admission(job, { ...calm, yieldRequestedAt: t0 - 500 }, t0).reason).toBe("yield");
    expect(admission(job, { ...calm, yieldRequestedAt: t0 - 5_000 }, t0).run).toBe(true);
    expect(admission(job, { ...calm, pools: { ...calm.pools, critical: 0.5 } }, t0).reason).toBe("critical-reserve");
    expect(admission(job, { ...calm, pools: { ...calm.pools, critical: 4.9 } }, t0).reason).toBe("critical-reserve");
    expect(admission(job, { ...calm, pools: { ...calm.pools, critical: 5 } }, t0).run).toBe(true);
  });

  it("resumes only after a full calm window and the stagger, from the saved cursor", () => {
    const running = advanceCursor(markRunning(createJob("j3", "export", 100, t0), t0, false), 35, t0, false);
    const parked = preempt(running, t0, "tier", 1);
    expect(admission(parked, { ...calm, tierChangedAt: t0 - 1_000 }, t0 + 600).reason).toBe("resume-wait");
    expect(admission(parked, { ...calm, tierChangedAt: t0 - 6_000 }, t0 + 100).reason).toBe("resume-wait");
    const a = admission(parked, { ...calm, tierChangedAt: t0 - 6_000 }, t0 + 600);
    expect(a.run).toBe(true);
    const resumed = markRunning(parked, t0 + 600, true);
    expect(resumed.cursor).toBe(35);
    expect(resumed.resumes).toBe(1);
  });

  it("aging guard grants one chunk under pressure, but never while the breaker is open", () => {
    const parked = preempt(markRunning(createJob("j4", "export", 100, t0), t0, false), t0, "tier", 0);
    const stressed: ServiceState = { ...calm, tier: 2 };
    expect(admission(parked, stressed, t0 + 9_000).run).toBe(false);
    const aged = admission(parked, stressed, t0 + 10_000);
    expect(aged.run).toBe(true);
    expect(aged.aging).toBe(true);
    expect(admission(parked, { ...calm, tier: 4 }, t0 + 10_000).run).toBe(false);
  });

  it("cursor only moves forward and completes exactly once", () => {
    let job = markRunning(createJob("j5", "export", 12, t0), t0, false);
    job = advanceCursor(job, 5, t0 + 1, false);
    job = advanceCursor(job, 5, t0 + 2, false);
    expect(job.state).toBe("RUNNING");
    job = advanceCursor(job, 5, t0 + 3, false);
    expect(job.cursor).toBe(12);
    expect(job.state).toBe("DONE");
    expect(cancel(job, t0 + 4).state).toBe("DONE");
  });

  it("resumes least deferrable first", () => {
    const a = { ...createJob("a", "", 10, 1), deferability: 3 };
    const b = { ...createJob("b", "", 10, 2), deferability: 0 };
    const c = { ...createJob("c", "", 10, 0), deferability: 3 };
    expect(resumeOrder([a, b, c]).map((j) => j.id)).toEqual(["b", "c", "a"]);
  });
});
