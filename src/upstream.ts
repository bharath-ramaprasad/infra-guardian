import { UPSTREAM_CFG } from "./core";

// The thing being protected. In-process, so the caller controls its failure rate, latency, and tail
// from query parameters; every parameter is clamped. It honours AbortSignal so hedge losers stop work.

export interface UpstreamParams {
  readonly fail: number;
  readonly latency: number;
  readonly tail: number;
}

export interface UpstreamResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly timeout: boolean;
  readonly aborted: boolean;
}

export function clampUpstreamParams(q: { fail?: string | null; latency?: string | null; tail?: string | null }): UpstreamParams {
  const num = (v: string | null | undefined, d: number) => {
    const n = v === null || v === undefined || v === "" ? NaN : Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    fail: Math.min(1, Math.max(0, num(q.fail, 0))),
    latency: Math.min(UPSTREAM_CFG.maxLatencyMs, Math.max(0, Math.round(num(q.latency, 120)))),
    tail: Math.min(1, Math.max(0, num(q.tail, 0))),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(t);
      resolve(false);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function callUpstream(p: UpstreamParams, signal?: AbortSignal, rand: () => number = Math.random, workMs = 0): Promise<UpstreamResult> {
  const started = Date.now();
  const slow = rand() < p.tail;
  const planned = Math.round(p.latency * (slow ? UPSTREAM_CFG.tailMultiplier : 1)) + workMs;
  const budget = Math.min(planned, UPSTREAM_CFG.timeoutMs);
  const completed = await sleep(budget, signal);
  const latencyMs = Date.now() - started;
  if (!completed) return { ok: false, latencyMs, timeout: false, aborted: true };
  if (planned > UPSTREAM_CFG.timeoutMs) return { ok: false, latencyMs, timeout: true, aborted: false };
  const failed = rand() < p.fail;
  return { ok: !failed, latencyMs, timeout: false, aborted: false };
}
