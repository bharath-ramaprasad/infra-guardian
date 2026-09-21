import type { Config, Context } from "@netlify/functions";
import { initialState } from "../../src/core";
import { badRequest, json, sessionId } from "../../src/http";
import { jobKey, jobsIndexKey, loadState, makeCtx, updateState, yieldKey } from "../../src/service";

// Per-session reset, at most once per 10 s. `?jev=off|on` toggles the Jev path for the session (survives the reset).

const MIN_INTERVAL_MS = 10_000;

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json(405, { error: "use POST" }, { allow: "POST" });
  const url = new URL(req.url);
  const sid = sessionId(url);
  if (!sid) return badRequest("pass ?s=<session id, 6-32 chars of [A-Za-z0-9_-]>");
  const jevParam = url.searchParams.get("jev");
  const ctx = await makeCtx(sid);
  const before = await loadState(ctx, Date.now());
  const lastReset = before.counters.lastResetAt ?? 0;
  const now = Date.now();
  if (now - lastReset < MIN_INTERVAL_MS) {
    const secs = Math.ceil((MIN_INTERVAL_MS - (now - lastReset)) / 1000);
    return json(
      429,
      { ok: false, error: "reset-too-soon", retryAfterMs: MIN_INTERVAL_MS - (now - lastReset) },
      { "retry-after": String(secs) },
    );
  }
  const idx = await ctx.store.get<string[]>(jobsIndexKey(sid));
  for (const id of idx?.value ?? []) await ctx.store.delete(jobKey(sid, id));
  await ctx.store.delete(jobsIndexKey(sid));
  await ctx.store.delete(yieldKey(sid));
  const r = await updateState(ctx, (cur, t) => {
    const off = jevParam === "off" ? true : jevParam === "on" ? false : cur.jev.off;
    const fresh = initialState(t);
    return { value: { ...fresh, jev: { ...fresh.jev, off }, counters: { lastResetAt: t } }, result: null };
  });
  console.info(JSON.stringify({ event: "session.reset", sid, jevOff: r.value.jev.off }));
  return json(200, { ok: true, tier: r.value.tier, jevOff: r.value.jev.off, resetAt: r.value.counters.lastResetAt });
};

export const config: Config = { path: "/api/reset" };
