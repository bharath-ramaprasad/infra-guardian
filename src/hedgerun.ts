import { sleep } from "./http";
import { callUpstream, type UpstreamParams, type UpstreamResult } from "./upstream";

// The hedge race: copy 1 now; copy 2 only if copy 1 has not returned by `delayMs`; first response wins; loser aborted.

export interface HedgeRun {
  readonly result: UpstreamResult;
  readonly elapsedMs: number;
  readonly hedgeHeader: string;
  readonly fired: boolean;
}

export async function runHedged(
  params: UpstreamParams,
  hedge: { allowed: boolean; gate: string | null; delayMs: number } | null,
  rand: () => number = Math.random,
): Promise<HedgeRun> {
  const started = Date.now();
  if (!hedge || !hedge.allowed) {
    const result = await callUpstream(params, undefined, rand);
    const hedgeHeader = !hedge || hedge.gate === "off" ? "off" : `gated-${hedge.gate}`;
    return { result, elapsedMs: Date.now() - started, hedgeHeader, fired: false };
  }
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  const copy1 = callUpstream(params, ac1.signal, rand).then((r) => ({ r, copy: 1 as const }));
  const first = await Promise.race([copy1, sleep(hedge.delayMs).then(() => null)]);
  if (first) return { result: first.r, elapsedMs: Date.now() - started, hedgeHeader: "armed", fired: false };
  const copy2 = callUpstream(params, ac2.signal, rand).then((r) => ({ r, copy: 2 as const }));
  const winner = await Promise.race([copy1, copy2]);
  (winner.copy === 1 ? ac2 : ac1).abort();
  return { result: winner.r, elapsedMs: Date.now() - started, hedgeHeader: `fired-won-by-${winner.copy}`, fired: true };
}
