/* infra-guardian demo page. Vanilla JS, no build step. */
(() => {
  const $ = (id) => document.getElementById(id);
  const url = new URL(location.href);
  let sid = url.searchParams.get("s");
  if (!sid || !/^[A-Za-z0-9_-]{6,32}$/.test(sid)) {
    sid = "demo-" + Math.random().toString(36).slice(2, 10);
    url.searchParams.set("s", sid);
    history.replaceState(null, "", url.toString());
  }
  $("sid").textContent = sid;
  $("statusLink").href = `/api/status?s=${sid}`;
  const q = (extra = "") => `s=${sid}${extra}`;

  // ---------- state ----------
  const log = [];
  const perSec = new Map(); // sec -> { ok, r429, r503, r5xx, latCrit: [], latBulk: [], tier }
  let status = null;
  let loadTimer = null;
  const inFlightSteps = new Set();
  const TIER_NAMES = ["NORMAL", "SOFT_THROTTLE", "HARD_THROTTLE", "SHED", "OPEN"];

  function bucket(sec) {
    if (!perSec.has(sec)) perSec.set(sec, { ok: 0, r429: 0, r503: 0, r5xx: 0, latCrit: [], latBulk: [], tier: status ? status.tier : 0 });
    for (const k of [...perSec.keys()]) if (k < sec - 90) perSec.delete(k);
    return perSec.get(sec);
  }

  function addLog(kind, res, ms) {
    const h = res.headers;
    const line = `${new Date().toLocaleTimeString()} ${kind.padEnd(8)} ${res.status} ${ms}ms tier=${(h.get("x-tier") || "?").split(" ")[0]} brk=${h.get("x-breaker") || "?"} pri=${(h.get("x-priority") || "?").split(" ")[0]} dec=${h.get("x-decider") || "?"} hedge=${h.get("x-hedge") || "-"} wait=${h.get("x-wait-ms") || 0} left=${h.get("x-ratelimit-remaining") || "-"}${h.get("retry-after") ? " retry-after=" + h.get("retry-after") : ""}`;
    log.unshift({ status: res.status, line });
    if (log.length > 25) log.pop();
    $("log").innerHTML = log.map((l) => `<div class="s${l.status}">${escapeHtml(l.line)}</div>`).join("");
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---------- requests ----------
  async function protectedCall(kind, description, idemKey, params) {
    const started = performance.now();
    const p = new URLSearchParams({ s: sid, fail: String(params.fail), latency: String(params.latency), tail: String(params.tail), hedge: params.hedge ? "1" : "0" });
    const body = { description };
    if (idemKey) body.idempotencyKey = idemKey;
    let res;
    try {
      res = await fetch(`/api/protected?${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      return null;
    }
    const ms = Math.round(performance.now() - started);
    const b = bucket(Math.floor(Date.now() / 1000));
    if (res.status === 200) b.ok++; else if (res.status === 429) b.r429++; else if (res.status === 503) b.r503++; else b.r5xx++;
    if (res.status === 200) (kind === "checkout" ? b.latCrit : b.latBulk).push(ms);
    addLog(kind, res, ms);
    return res;
  }

  function knobs() {
    return { fail: Number($("fail").value) / 100, latency: Number($("lat").value), tail: Number($("tail").value) / 100, hedge: $("hedgeOn").checked };
  }

  // ---------- panel 1: single request ----------
  const EXAMPLES = [
    "customer is on the phone waiting for their invoice PDF, read-only fetch",
    "charge the customer's card for order 4711",
    "health check from the load balancer",
    "nightly analytics export for the data warehouse",
    "user opens their order history page",
    "send the password reset email",
  ];
  $("chips").innerHTML = EXAMPLES.map((e) => `<span class="chip">${escapeHtml(e)}</span>`).join("");
  $("chips").querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { $("desc").value = c.textContent; }));

  $("sendOnce").addEventListener("click", async () => {
    const desc = $("desc").value.trim();
    if (!desc) return;
    $("sendOnce").disabled = true;
    const res = await protectedCall("once", desc, $("idem").checked ? "key-" + Math.random().toString(36).slice(2, 8) : null, knobs());
    $("sendOnce").disabled = false;
    if (!res) return;
    const j = await res.json().catch(() => ({}));
    const d = j.decision || {};
    const probs = d.probabilities || {};
    const el = $("onceResult");
    el.classList.remove("hidden");
    el.innerHTML = `
      <div class="kv">
        <b>HTTP</b><span class="s${res.status}">${res.status} ${j.ok ? "ok" : escapeHtml(j.error || "upstream " + (j.upstream && j.upstream.timeout ? "timeout" : "error"))}</span>
        <b>priority</b><span>${escapeHtml(d.priority || res.headers.get("x-priority") || "?")} · confidence ${fmt(d.confidence)} · decided by <code>${escapeHtml(d.decider || res.headers.get("x-decider"))}</code>${d.classified === "cache" ? " (cached)" : ""}</span>
        <b>safe to retry</b><span>${fmt(d.safeToRetry)} → hedge <code>${escapeHtml(d.hedge || res.headers.get("x-hedge") || "-")}</code></span>
        <b>admission</b><span>tier ${escapeHtml(res.headers.get("x-tier"))}, breaker ${escapeHtml(res.headers.get("x-breaker"))}, waited ${escapeHtml(res.headers.get("x-wait-ms"))} ms of a ${d.waitBudgetMs ?? "?"} ms budget, ${escapeHtml(res.headers.get("x-ratelimit-remaining"))} tokens left</span>
        <b>upstream</b><span>${j.upstream ? j.upstream.latencyMs + " ms" : "not called"}${d.probe ? " (half-open probe)" : ""}</span>
      </div>
      ${["critical", "standard", "bulk"].map((c) => `<div class="prob"><span>${c}</span><div class="bar"><i style="width:${Math.round((probs[c] || 0) * 100)}%"></i></div><span>${fmt(probs[c])}</span></div>`).join("")}`;
  });

  function fmt(n) { return typeof n === "number" ? n.toFixed(2) : "–"; }

  // ---------- panel 2: load ----------
  for (const [id, out] of [["rpsCrit", "rpsCritV"], ["rpsBulk", "rpsBulkV"], ["fail", "failV"], ["lat", "latV"], ["tail", "tailV"]]) {
    $(id).addEventListener("input", () => { $(out).textContent = $(id).value; });
  }
  let seq = 0;
  function tickLoad() {
    const k = knobs();
    const rc = Number($("rpsCrit").value), rb = Number($("rpsBulk").value);
    // Spread each stream's requests across the second.
    for (let i = 0; i < rc; i++) setTimeout(() => protectedCall("checkout", "customer waiting at checkout to confirm the order, read-only status fetch", "co-" + (seq++), k), (1000 * i) / Math.max(1, rc));
    for (let i = 0; i < rb; i++) setTimeout(() => protectedCall("export", "nightly analytics export for the data warehouse", null, k), (1000 * i) / Math.max(1, rb));
  }
  $("startLoad").addEventListener("click", () => {
    if (loadTimer) return;
    tickLoad();
    loadTimer = setInterval(tickLoad, 1000);
    $("startLoad").disabled = true; $("stopLoad").disabled = false;
  });
  $("stopLoad").addEventListener("click", () => { clearInterval(loadTimer); loadTimer = null; $("startLoad").disabled = false; $("stopLoad").disabled = true; });

  $("jevOn").addEventListener("change", async () => {
    const r = await fetch(`/api/reset?${q("&jev=" + ($("jevOn").checked ? "on" : "off"))}`, { method: "POST" });
    if (r.status === 429) { alert("Reset is limited to once per 10 s. Try again shortly."); $("jevOn").checked = !$("jevOn").checked; }
  });
  $("resetBtn").addEventListener("click", async () => {
    const r = await fetch(`/api/reset?${q()}`, { method: "POST" });
    if (r.status === 429) alert("Reset is limited to once per 10 s.");
    perSec.clear();
  });

  // ---------- charts ----------
  const C = { ok: "#2f7d4f", r429: "#b5730f", r503: "#b23a3a", r5xx: "#7a3f9c", crit: "#5145b8", bulk: "#888780", tier: "#c9571e" };
  $("legend").innerHTML = `<span><i style="background:${C.ok}"></i>200</span><span><i style="background:${C.r429}"></i>429 throttled</span><span><i style="background:${C.r503}"></i>503 shed / open</span><span><i style="background:${C.r5xx}"></i>502/504 upstream</span><span><i style="background:${C.crit}"></i>checkout p50 ms</span><span><i style="background:${C.bulk}"></i>export p50 ms</span><span><i style="background:${C.tier}"></i>tier 0–4</span>`;

  function drawCharts() {
    const now = Math.floor(Date.now() / 1000);
    const secs = Array.from({ length: 60 }, (_, i) => now - 59 + i);
    const rows = secs.map((s) => perSec.get(s) || { ok: 0, r429: 0, r503: 0, r5xx: 0, latCrit: [], latBulk: [], tier: null });
    // rates
    {
      const cv = $("chartRates"); const ctx = cv.getContext("2d"); cv.width = cv.clientWidth * devicePixelRatio; cv.height = 150 * devicePixelRatio; ctx.scale(devicePixelRatio, devicePixelRatio);
      const W = cv.clientWidth, H = 150, pad = 24; ctx.clearRect(0, 0, W, H);
      const max = Math.max(5, ...rows.map((r) => r.ok + r.r429 + r.r503 + r.r5xx));
      const bw = (W - pad) / 60;
      rows.forEach((r, i) => {
        let y = H - 4; const x = pad + i * bw;
        for (const [k, col] of [["ok", C.ok], ["r429", C.r429], ["r503", C.r503], ["r5xx", C.r5xx]]) {
          const h = (r[k] / max) * (H - 20); if (h > 0) { ctx.fillStyle = col; ctx.fillRect(x + 1, y - h, bw - 2, h); y -= h; }
        }
      });
      ctx.fillStyle = "#888"; ctx.font = "11px system-ui"; ctx.fillText(`${max}/s`, 0, 12); ctx.fillText("requests per second, last 60 s", pad, 12);
    }
    // latency + tier
    {
      const cv = $("chartLatency"); const ctx = cv.getContext("2d"); cv.width = cv.clientWidth * devicePixelRatio; cv.height = 150 * devicePixelRatio; ctx.scale(devicePixelRatio, devicePixelRatio);
      const W = cv.clientWidth, H = 150, pad = 24; ctx.clearRect(0, 0, W, H);
      const p50 = (a) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
      const lc = rows.map((r) => p50(r.latCrit)), lb = rows.map((r) => p50(r.latBulk));
      const maxL = Math.max(300, ...lc.filter(Boolean), ...lb.filter(Boolean));
      const bw = (W - pad) / 60;
      const line = (vals, col) => { ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); let started = false; vals.forEach((v, i) => { if (v === null) { started = false; return; } const x = pad + i * bw + bw / 2, y = H - 4 - (v / maxL) * (H - 20); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }); ctx.stroke(); };
      line(lc, C.crit); line(lb, C.bulk);
      // tier step line on 0..4 scale
      ctx.strokeStyle = C.tier; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.beginPath(); let st = false;
      rows.forEach((r, i) => { if (r.tier === null) return; const x = pad + i * bw, y = H - 4 - (r.tier / 4) * (H - 20); if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y); ctx.lineTo(x + bw, y); });
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#888"; ctx.font = "11px system-ui"; ctx.fillText(`${maxL}ms`, 0, 12); ctx.fillText("p50 latency by stream and tier (dashed)", pad, 12);
    }
  }

  // ---------- panel 3: batch ----------
  $("submitJob").addEventListener("click", async () => {
    $("submitJob").disabled = true;
    const r = await fetch(`/api/jobs?${q()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: $("jobDesc").value, items: Number($("jobItems").value) || 300 }) });
    $("submitJob").disabled = false;
    if (r.ok) refreshStatus();
  });

  async function stepJob(id) {
    if (inFlightSteps.has(id)) return;
    inFlightSteps.add(id);
    try {
      const k = knobs();
      await fetch(`/api/jobs/${id}/step?${q(`&fail=${k.fail}&latency=${k.latency}&tail=${k.tail}`)}`, { method: "POST" });
    } finally { inFlightSteps.delete(id); }
  }

  function renderJobs(jobs) {
    if (!jobs.length) { $("jobs").innerHTML = `<p class="hint">No jobs yet.</p>`; return; }
    $("jobs").innerHTML = jobs.slice().reverse().map((j) => {
      const pct = Math.round((j.cursor / j.items) * 100);
      return `<div class="job">
        <div><span class="st ${j.state}">${j.state}</span> · ${escapeHtml(j.description)} · deferability ${j.deferability}/4 (${escapeHtml(j.deferabilityDecider)}, conf ${fmt(j.deferabilityConfidence)})</div>
        <div class="bar"><i style="width:${pct}%; background:${j.state === "PREEMPTED" ? "var(--bad)" : "var(--accent)"}"></i></div>
        <div class="hint">${j.cursor}/${j.items} items · preempted ${j.preemptions}× · resumed ${j.resumes}× · last: ${escapeHtml(j.lastEvent ? j.lastEvent.event + (j.lastEvent.detail ? " (" + j.lastEvent.detail + ")" : "") : "-")}
        ${j.state !== "DONE" && j.state !== "CANCELLED" ? `<button class="ghost" data-cancel="${j.id}" style="padding:2px 8px;font-size:12px;margin-left:8px">cancel</button>` : ""}</div>
      </div>`;
    }).join("");
    $("jobs").querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => fetch(`/api/jobs/${b.dataset.cancel}/cancel?${q()}`, { method: "POST" })));
    for (const j of jobs) if (j.state === "QUEUED" || j.state === "RUNNING" || j.state === "PREEMPTED") stepJob(j.id);
  }

  // ---------- status polling ----------
  async function refreshStatus() {
    let r;
    try { r = await fetch(`/api/status?${q()}`); } catch { return; }
    if (!r.ok) return;
    status = await r.json();
    bucket(Math.floor(Date.now() / 1000)).tier = status.tier;
    $("tier").textContent = `${status.tier} ${status.tierName}`;
    $("tier").className = `big badge t${status.tier}`;
    $("tierSince").textContent = `since ${Math.round((status.now - status.tierSince) / 1000)} s · ${status.tierSpec.tokensPerSec} tokens/s, borrowing ${status.tierSpec.borrowing ? "on" : "off"}${status.store === "degraded" ? " · STORE DEGRADED (in-memory fallback)" : ""}`;
    $("breaker").textContent = status.breaker.state;
    $("breakerHint").textContent = status.breaker.state === "OPEN" ? `probe in ${Math.ceil(status.breaker.cooldownRemainingMs / 1000)} s (cooldown ${status.breaker.cooldownMs / 1000} s)` : status.breaker.state === "HALF_OPEN" ? "waiting for one probe" : `last window: ${status.window.last.n} calls, ${Math.round(status.window.last.errorRate * 100)}% errors, p95 ${status.window.last.p95Ms} ms`;
    $("decider").textContent = status.decider;
    $("stressHint").textContent = status.lastStress ? `Jev stress ${status.lastStress.score.toFixed(2)} (conf ${status.lastStress.confidence.toFixed(2)}) ${Math.round((status.now - status.lastStress.at) / 1000)} s ago` : "no stress score yet";
    $("jevBudget").textContent = `${status.jev.totalCalls} calls · ${status.jev.minuteCount}/60 this min`;
    $("jevHint").textContent = status.jev.off ? "advisory OFF for this session" : status.jev.innerBreakerOpenUntil && status.jev.innerBreakerOpenUntil > status.now ? "inner breaker open, deterministic" : status.jev.lastError ? `last error ${Math.round((status.now - status.jev.lastError.at) / 1000)} s ago: ${status.jev.lastError.message.slice(0, 40)}` : `backend ${status.jevBackend}${status.yieldActive ? " · yield flag raised" : ""}`;
    const caps = { critical: status.tierSpec.tokensPerSec * status.tierSpec.shares.critical, standard: status.tierSpec.tokensPerSec * status.tierSpec.shares.standard, bulk: status.tierSpec.tokensPerSec * status.tierSpec.shares.bulk };
    for (const [c, id] of [["critical", "poolCritical"], ["standard", "poolStandard"], ["bulk", "poolBulk"]]) {
      $(id).style.width = caps[c] > 0 ? `${Math.min(100, Math.round((status.pools[c] / caps[c]) * 100))}%` : "0%";
      $(id + "N").textContent = caps[c] > 0 ? `${Math.floor(status.pools[c])}/${Math.round(caps[c])}` : "shed";
    }
    $("jevOn").checked = !status.jev.off;
    renderJobs(status.jobs || []);
    const last = status.jev.last;
    $("jevLast").innerHTML = last ? `<b>Last Jev answer</b> (${escapeHtml(last.kind)}, ${last.latencyMs} ms, ${Math.round((status.now - last.at) / 1000)} s ago): <code>${escapeHtml(JSON.stringify(last.answers).slice(0, 600))}</code>` : `<span class="hint">No Jev answer yet in this session.</span>`;
    drawCharts();
  }
  refreshStatus();
  setInterval(refreshStatus, 1000);
  setInterval(drawCharts, 1000);
})();
