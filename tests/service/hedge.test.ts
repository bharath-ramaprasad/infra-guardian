import { describe, expect, it } from "vitest";
import { runHedged } from "../../src/service";

// rand() is consulted twice per upstream call: the tail draw before the sleep, the failure draw after it.
// Two overlapping copies therefore consume: copy1 tail, copy2 tail, then each failure draw as it completes.
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] ?? 0.99;
}

describe("hedge race", () => {
  const params = { fail: 0, latency: 100, tail: 0.5 };

  it("copy 2 wins when copy 1 hits the tail and copy 2 does not", async () => {
    const rand = seq([0.1, 0.9, 0.99, 0.99]); // copy1 tail: slow; copy2 tail: fast; failure draws: ok
    const r = await runHedged(params, { allowed: true, gate: null, delayMs: 150 }, rand);
    expect(r.hedgeHeader).toBe("fired-won-by-2");
    expect(r.elapsedMs).toBeGreaterThanOrEqual(240);
    expect(r.elapsedMs).toBeLessThan(450);
  });

  it("stays armed when copy 1 returns before the delay", async () => {
    const rand = seq([0.9, 0.99]);
    const r = await runHedged(params, { allowed: true, gate: null, delayMs: 300 }, rand);
    expect(r.hedgeHeader).toBe("armed");
    expect(r.elapsedMs).toBeLessThan(250);
  });

  it("copy 1 wins only when copy 2 is slow too", async () => {
    const rand = seq([0.1, 0.1, 0.99, 0.99]); // both copies slow
    const r = await runHedged(params, { allowed: true, gate: null, delayMs: 150 }, rand);
    expect(r.hedgeHeader).toBe("fired-won-by-1");
  });
});
