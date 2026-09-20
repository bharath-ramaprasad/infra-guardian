import { PRIORITIES, fullPools, poolCapacity, tierSpec, type Pools, type Priority, type Tier } from "./types";

// Per-class token pools. Capacity is one second of the class's share; refill is continuous.

export function refillPools(p: Pools, tier: Tier, now: number): Pools {
  const dt = Math.max(0, now - p.refilledAt) / 1000;
  const spec = tierSpec(tier);
  const next = { ...p, refilledAt: now };
  for (const cls of PRIORITIES) {
    const cap = poolCapacity(tier, cls);
    const rate = spec.tokensPerSec * spec.shares[cls];
    next[cls] = Math.min(cap, p[cls] + rate * dt);
  }
  return next;
}

export function recapPools(p: Pools, tier: Tier): Pools {
  const next = { ...p };
  for (const cls of PRIORITIES) next[cls] = Math.min(p[cls], poolCapacity(tier, cls));
  return next;
}

export function resetPools(tier: Tier, now: number): Pools {
  return fullPools(tier, now);
}

export interface TakeResult {
  readonly ok: boolean;
  readonly from: Priority | null;
  readonly pools: Pools;
  readonly retryAfterMs: number;
}

export function takeTokens(p: Pools, tier: Tier, cls: Priority, n = 1): TakeResult {
  if (p[cls] >= n) {
    return { ok: true, from: cls, pools: { ...p, [cls]: p[cls] - n }, retryAfterMs: 0 };
  }
  if (tierSpec(tier).borrowing) {
    let best: Priority | null = null;
    for (const other of PRIORITIES) {
      if (other === cls) continue;
      if (p[other] >= n && (best === null || p[other] > p[best])) best = other;
    }
    if (best !== null) return { ok: true, from: best, pools: { ...p, [best]: p[best] - n }, retryAfterMs: 0 };
  }
  return { ok: false, from: null, pools: p, retryAfterMs: retryAfterMs(p, tier, cls, n) };
}

export function retryAfterMs(p: Pools, tier: Tier, cls: Priority, n = 1): number {
  const spec = tierSpec(tier);
  const rate = spec.tokensPerSec * spec.shares[cls];
  if (rate <= 0) return 0;
  const deficit = Math.max(0, n - p[cls]);
  return Math.ceil((deficit / rate) * 1000);
}

export function hasCapacity(tier: Tier, cls: Priority): boolean {
  return tierSpec(tier).shares[cls] > 0;
}
