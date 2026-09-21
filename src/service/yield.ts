import type { ServiceState } from "../core";
import type { Ctx } from "./context";

// The yield flag lives on its own key with plain last-writer-wins writes, so critical pressure is recorded even
// when the main state key is contended. Readers merge it into `state.yieldRequestedAt` before deciding.

export function yieldKey(sid: string): string {
  return `s/${sid}/yield`;
}

export async function raiseYield(ctx: Ctx, now: number): Promise<void> {
  try {
    await ctx.store.set(yieldKey(ctx.sid), { at: now });
  } catch (err) {
    console.warn(JSON.stringify({ event: "yield.write_failed", sid: ctx.sid, message: err instanceof Error ? err.message : String(err) }));
  }
}

export async function withYield(ctx: Ctx, state: ServiceState): Promise<ServiceState> {
  const y = await ctx.store.get<{ at: number }>(yieldKey(ctx.sid));
  if (!y) return state;
  const at = Math.max(state.yieldRequestedAt ?? 0, y.value.at);
  return at === (state.yieldRequestedAt ?? 0) ? state : { ...state, yieldRequestedAt: at };
}
