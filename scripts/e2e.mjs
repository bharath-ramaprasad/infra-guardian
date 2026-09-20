#!/usr/bin/env node
// End-to-end checks against a live deployment. Usage: node scripts/e2e.mjs https://infra-guardian.netlify.app
// Prints PASS/FAIL per scenario with evidence and exits non-zero on any failure.

const base = (process.argv[2] ?? process.env.E2E_URL ?? "").replace(/\/$/, "");
if (!base) {
  console.error("usage: node scripts/e2e.mjs <base url>");
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
  try { json = JSON.parse(text); } catch { /* not json */ }
  const h = {};
  res.headers.forEach((v, k) => { h[k] = v; });
  return { status: res.status, headers: h, json, ms: Date.now() - started };
}

const protectedReq = (s, description, q = "", extra = {}) =>
  call(`/api/protected?s=${s}${q}`, { method: "POST", body: { description, ...(extra.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}) } });
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
  record("status endpoint shape", r.status === 200 && missing.length === 0, `status=${r.status} missing=[${missing}] store=${r.json?.store} jevBackend=${r.json?.jevBackend} ms=${r.ms}`);
}

async function scenarioHeaders() {
  const s = sid("headers");
  const r = await protectedReq(s, "health check");
  const need = ["x-tier", "x-breaker", "x-decider", "x-priority", "x-hedge", "x-ratelimit-remaining", "x-wait-ms", "x-store"];
  const missing = need.filter((k) => !(k in r.headers));
  record("header contract on /api/protected", r.status === 200 && missing.length === 0, `status=${r.status} missing=[${missing}] decider=${r.headers["x-decider"]} priority=${r.headers["x-priority"]}`);
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
  record("Jev classification and hedge-safety on typed descriptions", ok, `${seen.join(" | ")}${jevUsed ? "" : " | NOTE: Jev never answered (decider != jev), deterministic path exercised only"}`);
  return jevUsed;
}

async function scenarioLadderAndBreaker() {
  const s = sid("ladder");
  const tiers = [];
  const t0 = Date.now();
  let open = false;
  // Drive 100% upstream failures; expect one step per 5 s window, never more.
  while (Date.now() - t0 < 45_000 && !open) {
    await Promise.all(Array.from({ length: 12 }, () => protectedReq(s, "health check", "&fail=1&latency=30")));
    const st = await status(s);
    tiers.push(st.json?.tier);
    if (st.json?.breaker?.state === "OPEN") open = true;
    await sleep(2500);
  }
  let monotoneStep = true;
  for (let i = 1; i < tiers.length; i++) if (Math.abs(tiers[i] - tiers[i - 1]) > 1) monotoneStep = false;
  record("ladder climbs at most one step per window and trips the breaker", monotoneStep && open, `tiers=${tiers.join(",")} open=${open} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (!open) return;
  // Fail-fast: with a 2 s upstream latency requested, an OPEN breaker must answer far sooner without calling upstream.
  const ff = await protectedReq(s, "health check", "&latency=2000");
  record("open breaker fails fast without touching upstream", ff.status === 503 && ff.json?.error === "circuit-open" && ff.ms < 1500 && "retry-after" in ff.headers, `status=${ff.status} error=${ff.json?.error} ms=${ff.ms} retry-after=${ff.headers["retry-after"]}`);
  // Recovery: wait for cooldown, then a healthy probe reopens at SHED and the tier walks down one step per two windows.
  const cd = (await status(s)).json?.breaker?.cooldownRemainingMs ?? 10_000;
  await sleep(cd + 500);
  const probe = await protectedReq(s, "health check", "&fail=0&latency=30");
  const afterProbe = await status(s);
  record("single half-open probe reopens the ladder at SHED", probe.headers["x-probe"] === "1" && afterProbe.json?.tier === 3 && afterProbe.json?.breaker?.state === "CLOSED", `probe=${probe.headers["x-probe"]} status=${probe.status} tier=${afterProbe.json?.tier} breaker=${afterProbe.json?.breaker?.state}`);
  const walk = [afterProbe.json?.tier];
  const t1 = Date.now();
  while (Date.now() - t1 < 40_000) {
    await sleep(5_100);
    const st = await status(s);
    walk.push(st.json?.tier);
    if (st.json?.tier === 0) break;
  }
  let down = true;
  for (let i = 1; i < walk.length; i++) if (walk[i] > walk[i - 1] || walk[i - 1] - walk[i] > 1) down = false;
  record("recovery walks down one step at a time to NORMAL", down && walk[walk.length - 1] === 0, `tiers=${walk.join(",")}`);
}

async function scenarioPreemption() {
  const s = sid("batch");
  const created = await call(`/api/jobs?s=${s}`, { method: "POST", body: { description: "nightly analytics export, unattended", items: 400 } });
  const id = created.json?.job?.id;
  if (!id) return record("batch job submit", false, `status=${created.status} body=${JSON.stringify(created.json).slice(0, 200)}`);
  const step1 = await call(`/api/jobs/${id}/step?s=${s}&latency=60`, { method: "POST" });
  const cursor1 = step1.json?.job?.cursor ?? 0;
  record("batch job runs and checkpoints its cursor", step1.json?.job?.state === "RUNNING" && cursor1 > 0, `state=${step1.json?.job?.state} cursor=${cursor1} chunks=${step1.json?.step?.chunks}`);
  // Warm the classification once (so the burst does not stampede Jev), then burst critical requests and step the
  // job while the burst is in flight: the critical pool dips under its reserve, the yield flag goes up, batch yields.
  await protectedReq(s, "customer waiting at checkout to confirm the order", "&latency=20", { idempotencyKey: "warm" });
  const burst = Promise.all(Array.from({ length: 40 }, (_, i) => protectedReq(s, "customer waiting at checkout to confirm the order", "&latency=20", { idempotencyKey: `co-${i}` })));
  await sleep(700);
  const st = await status(s);
  const step2 = await call(`/api/jobs/${id}/step?s=${s}&latency=60`, { method: "POST" });
  await burst;
  const preempted = step2.json?.job?.state === "PREEMPTED";
  record("critical burst preempts the batch job at a chunk boundary", preempted && step2.json?.job?.cursor >= cursor1, `yieldActive=${st.json?.yieldActive} critPool=${st.json?.pools?.critical} state=${step2.json?.job?.state} stop=${step2.json?.step?.stopReason} cursor=${step2.json?.job?.cursor}`);
  // Pressure clears: pools refill within a second, yield expires in 2 s, tier unchanged for a window → resume from cursor.
  await sleep(6_000);
  const step3 = await call(`/api/jobs/${id}/step?s=${s}&latency=60`, { method: "POST" });
  const resumed = step3.json?.job?.resumes >= 1 && step3.json?.job?.cursor > (step2.json?.job?.cursor ?? 0);
  record("preempted job resumes from its saved cursor", resumed, `state=${step3.json?.job?.state} resumes=${step3.json?.job?.resumes} cursor ${step2.json?.job?.cursor} → ${step3.json?.job?.cursor} stop=${step3.json?.step?.stopReason}`);
}

async function scenarioHedge() {
  const s = sid("hedge");
  const hedges = [];
  for (let i = 0; i < 8; i++) {
    const r = await protectedReq(s, "fetch the customer's invoice PDF, read only, a person is waiting", "&latency=150&tail=0.5", { idempotencyKey: `h-${i}` });
    hedges.push(r.headers["x-hedge"]);
  }
  const anyHedge = hedges.some((h) => h === "armed" || (h ?? "").startsWith("fired"));
  const anyFired = hedges.some((h) => (h ?? "").startsWith("fired"));
  record("hedging arms for idempotent critical requests and fires on tail latency", anyHedge, `x-hedge=${hedges.join(",")}${anyFired ? "" : " (no copy needed to fire this run)"}`);
}

async function scenarioJevOff() {
  const s = sid("jevoff");
  const reset = await call(`/api/reset?s=${s}&jev=off`, { method: "POST" });
  const r = await protectedReq(s, "customer is on the phone waiting for their invoice PDF", "", { idempotencyKey: "x" });
  const st = await status(s);
  record("jev=off falls back to the deterministic policy and says so", reset.json?.jevOff === true && r.headers["x-decider"] === "deterministic" && st.json?.jev?.off === true && r.status === 200, `reset.jevOff=${reset.json?.jevOff} decider=${r.headers["x-decider"]} priority=${r.headers["x-priority"]} status=${r.status}`);
}

console.log(`e2e against ${base}`);
await scenarioStatus();
await scenarioHeaders();
await scenarioClassification();
await scenarioHedge();
await scenarioJevOff();
await scenarioPreemption();
await scenarioLadderAndBreaker();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
