# infra-guardian

A circuit breaker, rate limiter, and batch preemptor whose _policy_ is advised by [TypeSafe Jev](https://typesafe.ai) and whose _guarantees_ are enforced by code. It degrades predictably under stress: one tier at a time, with every response explaining why.

**Live demo:** https://infra-guardian.netlify.app — open it, type what a request is for, put the upstream under load, watch the ladder.

Built for the Anthropic SWE take-home, theme 3 (systems and reliability). Design rationale: [docs/RATIONALE.md](docs/RATIONALE.md). Plan: [docs/PLAN.md](docs/PLAN.md). Architecture: [docs/control-plane.md](docs/control-plane.md), [docs/data-plane.md](docs/data-plane.md).

## What it does

- **Tier ladder.** Five tiers from NORMAL to OPEN, each with a token budget split across three request classes. The tier moves at most one step per 5 s window, in either direction. No cliff edges.
- **Circuit breaker.** Owns tier 4: fail-fast, exponential cooldown, exactly one half-open probe, recovery re-enters the ladder at SHED and walks down.
- **Class pools with borrowing.** Critical, standard, and bulk each have a reserved share; borrowing is allowed only while calm. Lower classes wait (bounded) before they are dropped, so they degrade in latency first, then availability. Critical never degrades until the breaker opens.
- **Hedged requests** for the critical class: a second copy only after 1.5× the rolling p50 (300 ms until there are samples), first response wins, loser aborted. Four gates, all required: tier ≤ 1, critical pool has headroom, the client asserts idempotency, and Jev does not veto.
- **Batch preemption.** Batch jobs run in chunks with a checkpointed cursor. A critical request dipping into the critical reserve raises a yield flag; the job yields at the next chunk boundary and resumes from its cursor when pressure clears. An aging guard prevents starvation.
- **Jev as advisor, code as authority.** Jev answers four typed questions: request priority (choice), safe to retry (noul), upstream stress (score), and job deferability (score). Its answers carry probabilities and confidence. Low confidence is ignored, it can raise caution but never lower it below the deterministic rule, and it runs under a budget guard and an inner breaker. When any of that trips, the deterministic policy runs and `x-decider` says so.

- **Every decision explains itself.** Responses carry headers plus `why[]` and `state[]`: plain-language reasons built from the same state the decision used. Status exposes a tier-change history with the reason for each step. The page's details card shows all of it for any request you click.

Every visitor gets an isolated session namespace (`?s=`), so reviewers never see each other's stress.

## Try it with curl

```bash
S=demo-$RANDOM
U=https://infra-guardian.netlify.app

# A request with a description. Jev classifies it; headers explain the decision.
curl -si -X POST "$U/api/protected?s=$S" -H 'content-type: application/json' \
  -H 'idempotency-key: inv-1' \
  -d '{"description":"customer is on the phone waiting for their invoice PDF, read-only fetch"}' | grep -iE '^(HTTP|x-|retry)'

# Same shape, but money moves: still critical, never hedged.
curl -si -X POST "$U/api/protected?s=$S" -H 'content-type: application/json' \
  -d '{"description":"charge the customer'"'"'s card for order 4711"}' | grep -iE '^(HTTP|x-)'

# Stress the simulated upstream: fail=1 makes every upstream call fail. Watch the tier climb one step per window.
for i in $(seq 1 40); do curl -s -o /dev/null -X POST "$U/api/protected?s=$S&fail=1&latency=30" -H 'content-type: application/json' -d '{"description":"health check"}'; done
curl -s "$U/api/status?s=$S" | jq '{tier, tierName, breaker, decider, lastStress, pools}'

# Batch job: Jev scores deferability; step it; preempt it with a critical burst; watch it resume from its cursor.
J=$(curl -s -X POST "$U/api/jobs?s=$S" -H 'content-type: application/json' -d '{"description":"nightly analytics export, unattended","items":300}' | jq -r .job.id)
curl -s -X POST "$U/api/jobs/$J/step?s=$S" | jq '{state: .job.state, cursor: .job.cursor, stop: .step.stopReason}'

# Turn Jev off for the session and see the deterministic path, labelled.
curl -s -X POST "$U/api/reset?s=$S&jev=off" | jq
```

### Endpoints

| Method   | Path                                            | Purpose                                                                                                                                            |
| -------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST/GET | `/api/protected?s=&fail=&latency=&tail=&hedge=` | The guarded call. Body `{ description, idempotencyKey? }`. `fail` 0–1, `latency` ≤ 2000 ms, `tail` share of calls that take 5× longer.             |
| GET      | `/api/status?s=`                                | Tier, breaker, pools, window summary, tier-change history with reasons, `explain[]`, Jev budget and last answers, classifications, jobs, counters. |
| POST     | `/api/reset?s=&jev=on                           | off`                                                                                                                                               | Reset the session (once per 10 s). `jev=off` keeps Jev off for the session. |
| POST/GET | `/api/jobs?s=`                                  | Submit `{ description, items }` or list jobs.                                                                                                      |
| POST     | `/api/jobs/:id/step?s=`                         | Process chunks for up to 3 s, yielding on pressure. The page polls this; a scheduled tick also steps parked jobs.                                  |
| POST     | `/api/jobs/:id/cancel?s=`                       | Cancel.                                                                                                                                            |

### Response headers

`x-tier`, `x-breaker`, `x-decider` (`jev` · `deterministic` · `jev-bypassed-budget` · `jev-bypassed-lowconf` · `jev-error`), `x-priority` (class with probability), `x-wait-ms`, `x-hedge` (`off` · `gated-<gate>` · `armed` · `fired-won-by-N`), `x-ratelimit-remaining`, `x-ratelimit-reason`, `retry-after`, `x-store` (`ok` · `degraded`), `x-probe`, `x-upstream`. Full contract in [docs/data-plane.md](docs/data-plane.md#5-response-header-contract).

## Run it yourself

```bash
npm install
npm run check         # typecheck + lint + format + 36 unit and property tests (fast-check for the invariants)
npm run e2e -- https://infra-guardian.netlify.app   # live scenarios: ladder, breaker, recovery, preemption, hedging, jev-off
npm run dev           # netlify dev; JEV_FAKE=1 uses the keyword fake instead of Jev
npm run deploy        # netlify deploy --prod
```

Stack: Node 22, TypeScript, Netlify Functions v2 and Scheduled Functions, Netlify Blobs (strong reads, etag compare-and-set), `@typesafe-ai/sdk` through Netlify's AI Gateway. No framework on the page.

## Layout

```
src/core/            pure policy, no I/O: ladder, breaker, class pools, hedge gates, batch preemption, Jev guard, admission
src/jev/             Decider interface, real Jev client, keyword fake, the four question texts
src/store/           Store interface, Netlify Blobs with etag compare-and-set, memory fallback
src/service/         orchestration: context, window evaluation, classification with claim, outcomes, yield flag, jobs,
                     batch step, hedge race, plain-language explanations
src/upstream/        the simulated upstream being protected
src/http/            request parsing, validation, JSON responses with the header contract
netlify/functions/   thin handlers: protected, status, reset, jobs, job, tick
public/              the demo page, no build step
scripts/e2e.mjs      live verification
tests/core, tests/service   vitest + fast-check
docs/                plan, control plane, data plane, rationale
```

Dependency direction: functions → service → (core, jev, store, upstream, http). `src/core` imports nothing outside itself and never reads the clock; `now` is always passed in.

Quality gates: `npm run check` runs typecheck, ESLint (typescript-eslint type-checked rules), Prettier, and the tests.
