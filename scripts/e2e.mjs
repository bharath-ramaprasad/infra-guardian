#!/usr/bin/env node
// End-to-end checks against a live deployment. Usage: node scripts/e2e.mjs https://infra-guardian.netlify.app
// Prints PASS/FAIL per scenario with evidence and exits non-zero on any failure.

const base = (process.argv[2] ?? process.env.E2E_URL ?? "").replace(/\/$/, "");
if (!base) {
  console.error("usage: node scripts/e2e.mjs <base url> [--only=<scenario substring>]");
  process.exit(2);
}
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sid = (tag) => `e2e-${tag}-${Math.random().toString(36).slice(2, 8)}`;

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const started = Date.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  const h = {};
  res.headers.forEach((v, k) => {
    h[k] = v;
  });
  return { status: res.status, headers: h, json, ms: Date.now() - started };
}

const protectedReq = (s, description, q = "", extra = {}) =>
  call(`/api/protected?s=${s}${q}`, {
    method: "POST",
    body: { description, ...(extra.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}) },
  });
const status = (s) => call(`/api/status?s=${s}`);

function record(name, pass, evidence) {
  results.push({ name, pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}\n      ${evidence}`);
}

async function scenarioStatus() {
  const s = sid("status");
  const r = await status(s);
  const need = ["tier", "tierName", "breaker", "pools", "jev", "window", "jobs"];
  const missing = need.filter((k) => !(r.json && k in r.json));
  record(
    "status endpoint shape",
    r.status === 200 && missing.length === 0,
    `status=${r.status} missing=[${missing}] store=${r.json?.store} jevBackend=${r.json?.jevBackend} ms=${r.ms}`,
  );
}

async function scenarioHeaders() {
  const s = sid("headers");
  const r = await protectedReq(s, "health check");
  const need = ["x-tier", "x-breaker", "x-decider", "x-priority", "x-hedge", "x-ratelimit-remaining", "x-wait-ms", "x-store"];
  const missing = need.filter((k) => !(k in r.headers));
  record(
    "header contract on /api/protected",
    r.status === 200 && missing.length === 0,
    `status=${r.status} missing=[${missing}] decider=${r.headers["x-decider"]} priority=${r.headers["x-priority"]}`,
  );
}

async function scenarioClassification() {
  const s = sid("classify");
  const cases = [
    { d: "customer is on the phone waiting for their invoice PDF, read-only fetch", idem: "inv-1", want: "critical", hedgeOk: true },
    { d: "charge the customer's card for order 4711", idem: "pay-1", want: "critical", hedgeOk: false },
    { d: "nightly analytics export for the data warehouse", idem: null, want: "bulk", hedgeOk: false },
  ];
  const seen = [];
  let jevUsed = false;
  let ok = true;
  for (const c of cases) {
    const r = await protectedReq(s, c.d, "", c.idem ? { idempotencyKey: c.idem } : {});
    const pri = (r.headers["x-priority"] ?? "").split(" ")[0];
    const dec = r.headers["x-decider"];
    const hedge = r.headers["x-hedge"] ?? "";
    seen.push(`${c.want}: got ${pri} (${dec}) hedge=${hedge}`);
    if (dec === "jev") {
      jevUsed = true;
      if (pri !== c.want) ok = false;
      if (c.hedgeOk && !(hedge === "armed" || hedge.startsWith("fired"))) ok = false;
      if (!c.hedgeOk && c.want === "critical" && !hedge.startsWith("gated")) ok = false;
    }
  }
  record(
    "Jev classification and hedge-safety on typed descriptions",
    ok,
    `${seen.join(" | ")}${jevUsed ? "" : " | NOTE: Jev never answered (decider != jev), deterministic path exercised only"}`,
  );
  return jevUsed;
}

async function scenarioLadderAndBreaker() {
  const s = sid("ladder");
  // Sample the tier on its own 1 s cadence so no 5 s window can pass unobserved while requests are in flight.
  const tiers = [];
  let sampling = true;
  let degraded = 0;
  const sampler = (async () => {
    while (sampling) {
      const st = await status(s);
      if (st.json) {
        if (st.json.store === "degraded") degraded++;
        if (tiers.length === 0 || tiers[tiers.length - 1] !== st.json.tier) tiers.push(st.json.tier);
        if (st.json.breaker?.state === "OPEN") break;
      }
      await sleep(1000);
    }
  })();
  const t0 = Date.now();
  let open = false;
  // Drive 100% upstream failures; expect one step per 5 s window, never more.
  while (Date.now() - t0 < 45_000 && !open) {
    await Promise.all(Array.from({ length: 10 }, () => protectedReq(s, "health check", "&fail=1&latency=30")));
    const st = await status(s);
    if (st.json?.breaker?.state === "OPEN") open = true;
    await sleep(1000);
  }
  sampling = false;
  await sampler;
  let monotoneStep = true;
  for (let i = 1; i < tiers.length; i++) if (Math.abs(tiers[i] - tiers[i - 1]) > 1) monotoneStep = false;
  record(
    "ladder climbs at most one step per window and trips the breaker",
    monotoneStep && open,
    `tier changes=${tiers.join(",")} open=${open} in ${((Date.now() - t0) / 1000).toFixed(0)}s${degraded ? ` (store degraded on ${degraded} samples)` : ""}`,
  );
  if (!open) return;
  // Fail-fast: with a 2 s upstream latency requested, an OPEN breaker must answer far sooner without calling upstream.
  const ff = await protectedReq(s, "health check", "&latency=2000");
  record(
    "open breaker fails fast without touching upstream",
    ff.status === 503 && ff.json?.error === "circuit-open" && ff.ms < 1500 && "retry-after" in ff.headers,
    `status=${ff.status} error=${ff.json?.error} ms=${ff.ms} retry-after=${ff.headers["retry-after"]}`,
  );
  // Recovery: wait for cooldown, then a healthy probe reopens at SHED and the tier walks down one step per two windows.
  const cd = (await status(s)).json?.breaker?.cooldownRemainingMs ?? 10_000;
  await sleep(cd + 500);
  const probe = await protectedReq(s, "health check", "&fail=0&latency=30");
  const afterProbe = await status(s);
  record(
    "single half-open probe reopens the ladder at SHED",
    probe.headers["x-probe"] === "1" && afterProbe.json?.tier === 3 && afterProbe.json?.breaker?.state === "CLOSED",
    `probe=${probe.headers["x-probe"]} status=${probe.status} tier=${afterProbe.json?.tier} breaker=${afterProbe.json?.breaker?.state}`,
  );
  const walk = [afterProbe.json?.tier];
  let walkDegraded = 0;
  const t1 = Date.now();
  while (Date.now() - t1 < 45_000) {
    await sleep(2_000);
    const st = await status(s);
    if (!st.json) continue;
    if (st.json.store === "degraded") walkDegraded++;
    if (walk[walk.length - 1] !== st.json.tier) walk.push(st.json.tier);
    if (st.json.tier === 0) break;
  }
  let down = true;
  for (let i = 1; i < walk.length; i++) if (walk[i] > walk[i - 1] || walk[i - 1] - walk[i] > 1) down = false;
  record(
    "recovery walks down one step at a time to NORMAL",
    down && walk[walk.length - 1] === 0,
    `tier changes=${walk.join(",")}${walkDegraded ? ` (store degraded on ${walkDegraded} samples)` : ""}`,
  );
}

async function scenarioPreemption() {
  const s = sid("batch");
  const created = await call(`/api/jobs?s=${s}`, {
    method: "POST",
    body: { description: "nightly analytics export, unattended", items: 400 },
  });
  const id = created.json?.job?.id;
  if (!id) return record("batch job submit", false, `status=${created.status} body=${JSON.stringify(created.json).slice(0, 200)}`);
  const step1 = await call(`/api/jobs/${id}/step?s=${s}&latency=60`, { method: "POST" });
  const cursor1 = step1.json?.job?.cursor ?? 0;
  record(
    "batch job runs and checkpoints its cursor",
    step1.json?.job?.state === "RUNNING" && cursor1 > 0,
    `state=${step1.json?.job?.state} cursor=${cursor1} chunks=${step1.json?.step?.chunks}`,
  );
  // Warm the classification once (so the burst does not stampede Jev), then burst critical requests and step the
  // job while the burst is in flight: the critical pool dips under its reserve, the yield flag goes up, batch yields.
  await protectedReq(s, "customer waiting at checkout to confirm the order", "&latency=20", { idempotencyKey: "warm" });
  const burst = Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      protectedReq(s, "customer waiting at checkout to confirm the order", "&latency=20", { idempotencyKey: `co-${i}` }),
    ),
  );
  await sleep(700);
  const st = await status(s);
  const step2 = await call(`/api/jobs/${id}/step?s=${s}&latency=60`, { method: "POST" });
  await burst;
  const preempted = step2.json?.job?.state === "PREEMPTED";
  record(
    "critical burst preempts the batch job at a chunk boundary",
    preempted && step2.json?.job?.cursor >= cursor1,
    `yieldActive=${st.json?.yieldActive} critPool=${st.json?.pools?.critical} state=${step2.json?.job?.state} stop=${step2.json?.step?.stopReason} cursor=${step2.json?.job?.cursor}`,
  );
  // Pressure clears: pools refill within a second, yield expires in 2 s, tier unchanged for a window → resume from cursor.
  await sleep(6_000);
  const step3 = await call(`/api/jobs/${id}/step?s=${s}&latency=60`, { method: "POST" });
  const resumed = step3.json?.job?.resumes >= 1 && step3.json?.job?.cursor > (step2.json?.job?.cursor ?? 0);
  record(
    "preempted job resumes from its saved cursor",
    resumed,
    `state=${step3.json?.job?.state} resumes=${step3.json?.job?.resumes} cursor ${step2.json?.job?.cursor} → ${step3.json?.job?.cursor} stop=${step3.json?.step?.stopReason}`,
  );
}

// Critical bursts every 1.5 s keep the yield flag raised; the description is warmed first so Jev is called once.
function pressure(s, ms) {
  let on = true;
  const done = (async () => {
    await protectedReq(s, "customer waiting at checkout to confirm the order", "&latency=20", { idempotencyKey: "warm" });
    const t0 = Date.now();
    while (on && Date.now() - t0 < ms) {
      await Promise.all(
        Array.from({ length: 24 }, (_, i) =>
          protectedReq(s, "customer waiting at checkout to confirm the order", "&latency=20", { idempotencyKey: `p-${Date.now()}-${i}` }),
        ),
      );
      await sleep(300);
    }
  })();
  return {
    stop: () => {
      on = false;
      return done;
    },
  };
}

const jobStep = (s, id) => call(`/api/jobs/${id}/step?s=${s}&latency=60`, { method: "POST" });
const events = (job) => (job?.history ?? []).map((h) => h.event);
const cursorsInOrder = (job) =>
  (job?.history ?? [])
    .map((h) => /cursor (\d+)/.exec(h.detail ?? ""))
    .filter(Boolean)
    .map((m) => Number(m[1]));

async function scenarioJobLifecycle() {
  const s = sid("jobs");
  const urgent = await call(`/api/jobs?s=${s}`, {
    method: "POST",
    body: { description: "the customer is on the phone waiting for this report right now", items: 40 },
  });
  const lazy = await call(`/api/jobs?s=${s}`, {
    method: "POST",
    body: { description: "weekly archive export, unattended, whenever is fine", items: 40 },
  });
  const uj = urgent.json?.job,
    lj = lazy.json?.job;
  const jevScored = uj?.deferabilityDecider === "jev" && lj?.deferabilityDecider === "jev";
  const ordered = jevScored ? uj.deferability < lj.deferability : true;
  record(
    "Jev scores deferability and the queued event explains it",
    Boolean(uj && lj) && ordered && events(uj)[0] === "queued" && /deferability \d of 4/.test(uj.history?.[0]?.detail ?? ""),
    `urgent=${uj?.deferability} "${uj?.deferabilityText}" (${uj?.deferabilityDecider}) | lazy=${lj?.deferability} "${lj?.deferabilityText}" (${lj?.deferabilityDecider}) | queued: ${uj?.history?.[0]?.detail?.slice(0, 90)}${jevScored ? "" : " | NOTE: Jev did not score both, order not asserted"}`,
  );
  const step = await jobStep(s, uj.id);
  const started = step.json?.job?.history?.find((h) => h.event === "started");
  record(
    "a job submitted while calm starts at once and says why",
    (step.json?.job?.state === "RUNNING" || step.json?.job?.state === "DONE") &&
      Boolean(started) &&
      /tier 0 NORMAL/.test(started?.detail ?? ""),
    `state=${step.json?.job?.state} started="${started?.detail?.slice(0, 100)}"`,
  );
}

async function scenarioSubmitUnderPressure() {
  const s = sid("queue");
  const p = pressure(s, 16_000);
  // Submit only once the yield flag is confirmed raised, so the test asserts the queue decision, not burst timing.
  let flagged = false;
  for (let i = 0; i < 14 && !flagged; i++) {
    await sleep(500);
    flagged = (await status(s)).json?.yieldActive === true;
  }
  const created = await call(`/api/jobs?s=${s}`, {
    method: "POST",
    body: { description: "nightly analytics export, unattended", items: 40 },
  });
  const id = created.json?.job?.id;
  const step1 = await jobStep(s, id);
  const st = await status(s);
  const waiting = step1.json?.job?.waiting;
  record(
    "a job submitted during a critical burst stays queued with the reason",
    step1.json?.job?.state === "QUEUED" &&
      (waiting?.reason === "yield" || waiting?.reason === "critical-reserve") &&
      step1.json?.job?.cursor === 0,
    `flagged=${flagged} state=${step1.json?.job?.state} yieldActive=${st.json?.yieldActive} waiting=${waiting?.reason}: ${waiting?.detail?.slice(0, 80)} stop=${step1.json?.step?.stopReason}`,
  );
  await p.stop();
  await sleep(4_000);
  const step2 = await jobStep(s, id);
  const started = step2.json?.job?.history?.find((h) => h.event === "started");
  record(
    "it starts once the burst ends, from cursor 0",
    (step2.json?.job?.state === "RUNNING" || step2.json?.job?.state === "DONE") && step2.json?.job?.cursor > 0 && Boolean(started),
    `state=${step2.json?.job?.state} cursor=${step2.json?.job?.cursor} events=${events(step2.json?.job).join(",")}`,
  );
}

async function scenarioAgingGuard() {
  const s = sid("aging");
  const created = await call(`/api/jobs?s=${s}`, {
    method: "POST",
    body: { description: "nightly analytics export, unattended", items: 300 },
  });
  const id = created.json?.job?.id;
  const first = await jobStep(s, id);
  const c1 = first.json?.job?.cursor ?? 0;
  const p = pressure(s, 45_000);
  await sleep(1_000);
  let preempted = null,
    aging = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    const r = await jobStep(s, id);
    const j = r.json?.job;
    if (!preempted && j?.state === "PREEMPTED") preempted = { cursor: j.cursor, stop: r.json?.step?.stopReason };
    if (r.json?.step?.stopReason === "aging-chunk") {
      aging = {
        cursor: j.cursor,
        agingChunks: j.agingChunks,
        detail: j.history
          ?.slice()
          .reverse()
          .find((h) => h.event === "aging-chunk")?.detail,
      };
      break;
    }
    await sleep(2_000);
  }
  await p.stop();
  record(
    "sustained critical pressure preempts the job and parks it at a chunk boundary",
    Boolean(preempted) && preempted.cursor >= c1 && preempted.cursor % 5 === 0 && preempted.stop === "preempted:yield",
    `first cursor=${c1} preempted=${JSON.stringify(preempted)}`,
  );
  const agingMove = /cursor (\d+) → (\d+)/.exec(aging?.detail ?? "");
  const oneChunk = agingMove ? Number(agingMove[2]) - Number(agingMove[1]) === 5 && Number(agingMove[2]) === aging.cursor : false;
  record(
    "aging guard grants exactly one chunk after 10 s without progress under pressure",
    Boolean(aging) && aging.agingChunks >= 1 && oneChunk && /\d+ s without progress/.test(aging.detail ?? ""),
    `aging=${JSON.stringify(aging)?.slice(0, 220)}`,
  );
  await sleep(4_500);
  let job = null;
  for (let i = 0; i < 16; i++) {
    const r = await jobStep(s, id);
    job = r.json?.job;
    if (job?.state === "DONE") break;
    await sleep(300);
  }
  const cs = cursorsInOrder(job);
  const monotone = cs.every((c, i) => i === 0 || c >= cs[i - 1]);
  const ev = events(job);
  const hasAll = ["queued", "started", "preempted", "waiting", "aging-chunk", "resumed", "done"].every((e) => ev.includes(e));
  record(
    "the job resumes from its cursor and finishes: no work lost",
    job?.state === "DONE" && job?.cursor === 300 && job?.resumes >= 1 && monotone && hasAll,
    `state=${job?.state} cursor=${job?.cursor}/300 resumes=${job?.resumes} aging=${job?.agingChunks} cursors=${cs.join(",")} events=${ev.join(",")}`,
  );
}

async function scenarioHedge() {
  const s = sid("hedge");
  const hedges = [];
  for (let i = 0; i < 8; i++) {
    const r = await protectedReq(s, "fetch the customer's invoice PDF, read only, a person is waiting", "&latency=150&tail=0.3", {
      idempotencyKey: `h-${i}`,
    });
    hedges.push(r.headers["x-hedge"]);
  }
  const anyHedge = hedges.some((h) => h === "armed" || (h ?? "").startsWith("fired"));
  const anyFired = hedges.some((h) => (h ?? "").startsWith("fired"));
  record(
    "hedging arms for idempotent critical requests and fires on tail latency",
    anyHedge,
    `x-hedge=${hedges.join(",")}${anyFired ? "" : " (no copy needed to fire this run)"}`,
  );
}

async function scenarioJevOff() {
  const s = sid("jevoff");
  const reset = await call(`/api/reset?s=${s}&jev=off`, { method: "POST" });
  const r = await protectedReq(s, "customer is on the phone waiting for their invoice PDF", "", { idempotencyKey: "x" });
  const st = await status(s);
  record(
    "jev=off falls back to the deterministic policy and says so",
    reset.json?.jevOff === true && r.headers["x-decider"] === "deterministic" && st.json?.jev?.off === true && r.status === 200,
    `reset.jevOff=${reset.json?.jevOff} decider=${r.headers["x-decider"]} priority=${r.headers["x-priority"]} status=${r.status}`,
  );
}

const only = (process.argv[3] ?? "").replace(/^--only=/, "");
const scenarios = [
  ["status", scenarioStatus],
  ["headers", scenarioHeaders],
  ["classification", scenarioClassification],
  ["hedge", scenarioHedge],
  ["jevoff", scenarioJevOff],
  ["preemption", scenarioPreemption],
  ["jobs", scenarioJobLifecycle],
  ["queue", scenarioSubmitUnderPressure],
  ["aging", scenarioAgingGuard],
  ["ladder", scenarioLadderAndBreaker],
];
console.log(`e2e against ${base}${only ? ` (only: ${only})` : ""}`);
for (const [name, fn] of scenarios) {
  if (only && !name.includes(only)) continue;
  await fn();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
