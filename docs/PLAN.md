# Jev-based circuit breaker, rate limiter, and batch preemption — demo plan (v2)

Scope: demoable, functional, tested end to end, live on a public URL. Scale is explicitly out of scope.

## 1. Platform: Netlify Free plan
- Functions (Node 20, v2 Request/Response API), Scheduled Functions, Blobs, AI Gateway with `@typesafe-ai/sdk` zero-config.
- Jev is not on Vercel's free AI Gateway tier; on Netlify it bills to the 300 free credits/month (~0.003 credits per call).
- AI Gateway activates only after the first production deploy, so deploy a hello function first.
- Stack: TypeScript, vitest (unit), Playwright (e2e against the live URL), static `index.html` + vanilla JS.

## 2. Two workload types, two degradation behaviours

| Workload            | Unit of work            | Under pressure it…                      | Guarantee                                              |
|---------------------|-------------------------|-----------------------------------------|--------------------------------------------------------|
| Interactive request | one HTTP call, < 2 s    | waits (bounded), then 429               | critical never degrades until the breaker opens        |
| Batch job           | N chunks, ~200 ms each  | yields at the next chunk boundary       | never loses work, never starves, always finishes       |

### 2.1 Tier ladder (shared by both)
| Tier | Name          | Tokens/s | Class shares crit/std/bulk | Borrowing | Batch chunks/s | Rejected interactive → |
|------|---------------|----------|----------------------------|-----------|----------------|------------------------|
| 0    | NORMAL        | 50       | 40% / 40% / 20%            | yes       | 10             | 429 + Retry-After      |
| 1    | SOFT_THROTTLE | 30       | 50% / 35% / 15%            | yes       | 5              | 429 + Retry-After      |
| 2    | HARD_THROTTLE | 15       | 60% / 40% / 0%             | no        | 0 (preempted)  | 429 / 503 bulk         |
| 3    | SHED          | 5        | 100% / 0% / 0%             | no        | 0 (preempted)  | 503 shed               |
| 4    | OPEN          | 0        | probe only                 | no        | 0              | 503 circuit-open       |

Transitions: 5 s evaluation window, at most ±1 tier per window. An evaluation looks at every outcome since the previous
evaluation (capped at two windows), so a burst that ended a few seconds before anyone evaluated still counts. Escalate on error rate ≥ 50% over ≥ 10 calls,
p95 ≥ 1500 ms, or ≥ 5 timeouts. De-escalate after 2 clean windows. OPEN → HALF_OPEN after 10 s (doubling, cap 60 s);
one probe; success → tier 3 and walk down, failure → OPEN.

### 2.2 Interactive path: reserved capacity + wait-before-drop
- Per-class token pools per tier (table above). In tiers 0–1 a class may borrow unused tokens from others; in tiers ≥ 2 it may not.
- No token → wait and retry inside the invocation up to a per-class budget: critical 0 ms, standard 500 ms, bulk 1500 ms.
  Critical requests arriving during a wait take tokens first. Budget exhausted → 429 with Retry-After.
- Jev choice `priority` gives probabilities; wait budget = probability-weighted mean of the class budgets.
  Confidence < 0.6 → treated as standard (never promoted to critical by uncertainty).
- A critical request that cannot be admitted promptly (pool empty, dipped under the 25% critical reserve, or lost the
  admission CAS race) raises the yield flag. It is stored on its own key (`s/<sid>/yield`, plain write) so contention on the
  main state key cannot hide it. This is the preemption signal for batch.

### 2.3 Batch path: cooperative preemption at checkpoints
Job record `job/<id>`: `{ items, cursor, state, deferability, submittedAt, resumeAfter, history[] }`.
States: QUEUED → RUNNING ⇄ PREEMPTED → DONE | CANCELLED.
- Step = process up to `chunksPerSec × 3` chunks in one invocation (≤ 3 s), one chunk at a time, each ≤ 200 ms upstream.
- Before every chunk: re-read `svc/state`. Preempt (save cursor, state=PREEMPTED) if tier ≥ 2, or critical pool under its 25% reserve,
  or `yieldRequestedAt` within the last 2 s. Preemption latency is therefore ≤ one chunk.
- Resume when tier ≤ 1 for one full window and no yield in the last 2 s; jobs resume in ascending deferability with a
  0–500 ms stagger. Aging guard: any PREEMPTED job gets 1 chunk / 10 s unless tier is 4.
- Jev score `deferability` at submission (0 = someone is waiting on it … 4 = unattended nightly export). Confidence < 0.6 → level 2.
- Driver: the browser polls `POST /api/jobs/:id/step`; the scheduled tick also steps PREEMPTED/QUEUED jobs so they finish without a tab.

## 3. Jev usage (one `systemOne` call per evaluation, 800 ms timeout, fake in tests)
```ts
// interactive request
priority: choice("Classify the priority of this API request for load shedding", {
  critical: "Health checks, payments, confirmations, idempotent retries",
  standard: "Ordinary interactive user requests",
  bulk:     "Exports, crawls, prefetch, analytics, anything marked low priority",
}),
abusive: noul("Is this client's recent pattern abusive (repeated bursts, ignoring Retry-After)?"),
// window evaluation
stress: score("How stressed is the upstream given the last 50 outcomes and trend", [
  "Healthy: errors under 5%, latency stable",
  "Warming: latency rising or a few errors, trend flat",
  "Degrading: errors 20–50% or p95 near timeout, trend worsening",
  "Failing: majority errors or timeouts, still worsening",
  "Down: nearly all calls fail or time out",
]),
// batch submission
deferability: score("How deferrable is this batch job", [
  "A person is waiting on the result right now",
  "Needed within minutes",
  "Needed within the hour",
  "Needed today",
  "Unattended, any time is fine",
]),
```
Merge rule for tier: `final = clamp(max(deterministic, jevIfConfident), current−1, current+1)`.
Budget guard: ≤ 60 Jev calls/min, ≤ 3000/day; 3 consecutive errors → skip Jev 30 s. All fallbacks visible in `x-decider`.

## 4. State and concurrency (demo-sized)
- `svc/state`: tier, breaker, pools, telemetry ring (50), lastWindow, jevBudget, yieldRequestedAt. CAS via `onlyIfMatch`, ≤ 3 retries.
- `client/<hash(ip+ua)>`: bucket, history (20), penaltyUntil, cachedPriority. CAS, ≤ 3 retries.
- `job/<id>`: as above. CAS, ≤ 3 retries; a step that loses CAS 3 times exits and the next poll retries.
- Window evaluation runs inside whichever request or tick first sees `lastWindow < currentWindow`, as part of its CAS update.
- Blobs unreachable → in-memory fallback for that invocation only, `x-store: degraded`; the Blobs client is created per invocation because the runtime's Blobs token is short-lived and a cached client fails with "Token expired" on warm instances (found by the live verifier).

## 5. Endpoints
- `POST /api/protected?fail=&latency=` — interactive path; simulated upstream in-process (caps: fail ≤ 1, latency ≤ 2000).
- `POST /api/jobs` `{ items, description }` → job id (Jev scores deferability). `POST /api/jobs/:id/step`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`.
- `GET /api/status` — tier, breaker, pools, jobs summary, last Jev answers with probabilities and confidence, budget.
- `POST /api/reset` — throttled to 1 / 10 s.
- Scheduled `tick` every minute — window evaluation when idle, breaker recovery, steps parked jobs.
- Headers on every response: `x-tier`, `x-breaker`, `x-decider`, `x-priority`, `x-wait-ms`, `x-ratelimit-remaining`, `retry-after`.

## 6. UI (`index.html`)
- Tier badge, breaker state, decider source, Jev budget.
- Two interactive streams with sliders: checkout-shaped (critical) and export-shaped (bulk); stress knob (fail %, latency).
- Batch panel: submit a 500-item job with a description; progress bar; state badge (running / preempted / done); resume count.
- Strip chart: p50 latency per class and 429/503 counts; batch chunks/s. The proof: bulk latency climbs and the job stalls
  while checkout latency stays flat, then the job resumes from its cursor.
- Why panel: last Jev answers with probability bars and confidence.

## 7. Tests
Unit (vitest, fake Jev):
1. Pools and borrowing per tier; wait-budget from probabilities; low confidence → standard.
2. Breaker transitions, half-open single probe, backoff cap.
3. Ladder property (fast-check): |Δtier| ≤ 1 per window for any proposal sequence; Jev never lowers below deterministic.
4. Batch: preempts before the next chunk when yield/tier says so; cursor preserved; aging guard fires; resume order by deferability.
E2E (Playwright vs live URL, real Jev):
1. Burst → 429s with Retry-After; tier climbs one step per window.
2. `fail=1` → breaker open, fail-fast < 100 ms; recovery walks down one tier per window.
3. Submit job, start critical burst → job PREEMPTED within 1 chunk, critical p50 flat; stop burst → job resumes and completes with cursor continuity.
4. Jev off (`/api/reset?jev=off`) → all `x-decider: deterministic`, scenarios 1–3 still hold.
5. Export-shaped request → `x-priority: bulk`, waits then 429 under HARD_THROTTLE; checkout-shaped → critical, served.

## 8. Build order (≈ 2 h)
| Time      | Work                                                                                  |
|-----------|---------------------------------------------------------------------------------------|
| 0:00–0:15 | scaffold, hello function, first production deploy (activates AI Gateway)              |
| 0:15–0:50 | pure core: ladder, breaker, pools, batch step logic; unit + property tests green       |
| 0:50–1:15 | Blobs store with CAS, Jev layer + fake, endpoints, scheduled tick; `netlify dev`       |
| 1:15–1:35 | UI: streams, batch panel, chart, why panel                                             |
| 1:35–1:55 | deploy, Playwright e2e vs prod, tune thresholds from real Jev latency                 |
| 1:55–2:00 | README: contract tables, headers, how to run tests                                    |

## 9. Risks
- Netlify Free credits (300/month) are a hard stop for the whole site; keep caps low, set a spend alert.
- Jev latency unmeasured until deploy; 800 ms timeout and per-window memoization bound the impact.
- Client-driven batch stepping stops if the tab closes; the minute tick covers it, slowly.
- `@typesafe-ai/sdk` 0.6.0 exposes `choice`; verify `score`/`noul` helper signatures on install.

## 10. Amendments (v2.1, agreed after reviewing the assignment)

### 10.1 Assignment alignment (Anthropic SWE take-home, theme 3)
- Deliverables: deployed prototype (Netlify), GitHub repo, written rationale + ~5 min video, AI transcripts, time spent.
- Self-contained: load generator + simulated upstream in the page; curl examples in README for API-only evaluation.
- Per-visitor namespaces: state keys prefixed by a session id in the URL (`?s=<id>`), so reviewers never see each other's stress.
  A "shared arena" namespace is optional. Reset is per session and therefore public, no secret.
- Jev showcase is the reviewer's own typed description of a request or job; class, deferability, hedge-safety and their
  probabilities are shown before the request is sent. Jev-off toggle proves the system stays safe without it.
- Cuts: the `abusive` noul is dropped; Playwright is replaced by `scripts/e2e.mjs`, a node script that hits the live URL and
  asserts status codes and headers. Everything else in v2 stays, including the scheduled tick.
- After end-to-end testing passes, move Netlify to the $9 Personal plan for the review window (credits are a hard stop on Free).
- Rationale language: "cooperative preemption at chunk boundaries, browser-driven"; "hedged requests", never "anycast".

### 10.2 Hedged requests for the critical class
Goal: best tail latency for critical requests without amplifying upstream stress.
- Mode: 1:2 delayed hedge. Send copy 2 only if copy 1 has not returned within 1.5× the rolling p50 upstream latency (300 ms default until 5 samples; floor 50 ms);
  first response wins; the loser is aborted via AbortController and the simulated upstream honours the abort.
- Gates, all required:
  1. Tier ≤ 1 (NORMAL or SOFT_THROTTLE). Off at HARD_THROTTLE and above.
  2. Critical pool has ≥ 2 tokens; each copy consumes one. Hedging is the first thing critical loses under pressure.
  3. Idempotent: GET, or POST with an `Idempotency-Key` header. Deterministic, cannot be overridden.
  4. Jev noul `safeToRetry` ≥ 0.7 on the request description (e.g. "invoice PDF" yes, "charge card" no).
- Critical degradation order: hedge → wait budget → admission → (breaker) fail-fast.
- Simulated upstream gains a tail knob: `tail=0.1` means 10% of calls take 5× the base latency.
- Visible: `x-hedge: off | armed | fired-won-by-1 | fired-won-by-2 | gated-<reason>`; chart adds critical p99 with hedge on/off.
- Extension only: M:N quorum (2:3) for correctness-checking replicas; not built.

### 10.3 Jev questions, final set
`priority` (choice), `stress` (score), `deferability` (score), `safeToRetry` (noul). Confidence gates: 0.6 for the scores/choice,
0.7 for `safeToRetry`. All advisory; deterministic rules bound every outcome.
