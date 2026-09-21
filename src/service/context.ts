import { initialState, type ServiceState } from "../core";
import { resolveDecider, type Decider } from "../jev";
import { resolveStore, updateWithCas, type Store } from "../store";

// Per-request context and the session state record. Every write to the state record is a CAS update.

export interface Ctx {
  readonly sid: string;
  readonly store: Store;
  readonly degraded: boolean;
  readonly decider: Decider;
  readonly stateKey: string;
}

export const SESSIONS_KEY = "sessions";

export interface SessionEntry {
  readonly sid: string;
  readonly at: number;
}

export async function makeCtx(sid: string): Promise<Ctx> {
  const { store, degraded } = await resolveStore();
  return { sid, store, degraded, decider: resolveDecider(), stateKey: `s/${sid}/svc` };
}

export async function loadState(ctx: Ctx, now: number): Promise<ServiceState> {
  const cur = await ctx.store.get<ServiceState>(ctx.stateKey);
  if (cur) return cur.value;
  const fresh = initialState(now);
  await ctx.store.set(ctx.stateKey, fresh, { onlyIfNew: true });
  const again = await ctx.store.get<ServiceState>(ctx.stateKey);
  return again ? again.value : fresh;
}

export async function updateState<R>(ctx: Ctx, fn: (cur: ServiceState, now: number) => { value: ServiceState; result: R }) {
  return updateWithCas(
    ctx.store,
    ctx.stateKey,
    () => initialState(Date.now()),
    (cur) => fn(cur, Date.now()),
  );
}

/** Remember which sessions were active recently so the scheduled tick can walk them. */
export async function touchSession(ctx: Ctx, now: number): Promise<void> {
  await updateWithCas<SessionEntry[], null>(
    ctx.store,
    SESSIONS_KEY,
    () => [],
    (cur) => {
      const others = cur.filter((e) => e.sid !== ctx.sid && now - e.at < 30 * 60_000);
      const next = [...others, { sid: ctx.sid, at: now }].slice(-100);
      return { value: next, result: null };
    },
    2,
  );
}
