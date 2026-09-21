import type { Job } from "../core";
import { updateWithCas } from "../store";
import type { Ctx } from "./context";

// Job records and the per-session job index.

export function jobKey(sid: string, id: string): string {
  return `s/${sid}/job/${id}`;
}

export function jobsIndexKey(sid: string): string {
  return `s/${sid}/jobs`;
}

export async function listJobs(ctx: Ctx): Promise<Job[]> {
  const idx = await ctx.store.get<string[]>(jobsIndexKey(ctx.sid));
  if (!idx) return [];
  const jobs = await Promise.all(idx.value.map((id) => ctx.store.get<Job>(jobKey(ctx.sid, id))));
  return jobs.flatMap((j) => (j ? [j.value] : []));
}

export async function addJobToIndex(ctx: Ctx, id: string): Promise<void> {
  await updateWithCas<string[], null>(
    ctx.store,
    jobsIndexKey(ctx.sid),
    () => [],
    (cur) => ({ value: [...cur.filter((x) => x !== id), id].slice(-20), result: null }),
  );
}

export async function updateJob(ctx: Ctx, id: string, fn: (job: Job) => Job): Promise<Job | null> {
  const cur = await ctx.store.get<Job>(jobKey(ctx.sid, id));
  if (!cur) return null;
  const r = await updateWithCas<Job, null>(
    ctx.store,
    jobKey(ctx.sid, id),
    () => cur.value,
    (j) => ({ value: fn(j), result: null }),
  );
  return r.value;
}
