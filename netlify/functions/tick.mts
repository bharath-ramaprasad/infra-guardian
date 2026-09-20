import type { Config } from "@netlify/functions";
import { resumeOrder } from "../../src/core";
import { DEFAULT_BATCH_PARAMS, stepJob } from "../../src/batchrun";
import { SESSIONS_KEY, ensureWindow, listJobs, loadState, makeCtx, type SessionEntry } from "../../src/service";
import { resolveStore } from "../../src/store";

// Scheduled every minute: idle recovery (deterministic only, no Jev spend) and one step for parked jobs,
// so a stressed session heals and its batch work finishes even with no tab open.

export default async () => {
  const now = Date.now();
  const { store } = await resolveStore();
  const sessions = await store.get<SessionEntry[]>(SESSIONS_KEY);
  const active = (sessions?.value ?? []).filter((e) => now - e.at < 15 * 60_000).slice(-25);
  const report: Record<string, unknown>[] = [];
  for (const e of active) {
    const ctx = await makeCtx(e.sid);
    const state = await loadState(ctx, now);
    const win = await ensureWindow(ctx, state, Date.now(), false);
    const parked = resumeOrder((await listJobs(ctx)).filter((j) => j.state === "QUEUED" || j.state === "PREEMPTED"));
    const stepped: string[] = [];
    for (const job of parked.slice(0, 5)) {
      const r = await stepJob(ctx, job.id, DEFAULT_BATCH_PARAMS, 1500, false);
      stepped.push(`${job.id}:${r.stopReason}`);
    }
    report.push({ sid: e.sid, tier: win.state.tier, evaluated: win.evaluated, stepped });
  }
  console.info(JSON.stringify({ event: "tick", sessions: report.length, report }));
  return new Response(JSON.stringify({ ok: true, sessions: report.length }), { headers: { "content-type": "application/json" } });
};

export const config: Config = { schedule: "* * * * *" };
