# infra-guardian — working agreement for Claude Code

A Jev-guided circuit breaker, rate limiter, and batch preemption service that degrades predictably under stress.
Built for the Anthropic SWE take-home (theme 3, systems and reliability). Read `docs/PLAN.md` first, then
`docs/control-plane.md` and `docs/data-plane.md`. The plan is the spec; if code and plan disagree, say so before changing either.

## Stack

- Runtime: Node 22, TypeScript, ESM. Netlify Functions v2 (`Request`/`Response`), Scheduled Functions, Netlify Blobs.
- Decision model: TypeSafe Jev via Netlify AI Gateway using `@typesafe-ai/sdk` (zero-config; env is injected after the first production deploy).
- Frontend: static `public/index.html`, vanilla JS, canvas chart. No framework, no build step for the page.
- Tests: vitest + fast-check for the pure core; `scripts/e2e.mjs` runs against a live URL.
- Deploy: Netlify CLI (`netlify deploy --prod`). Repo: github.com/bharath-ramaprasad/infra-guardian.

## Layout

```
src/core/            pure policy, no I/O: types and tables, telemetry, breaker, pools, ladder, hedge gates, batch, Jev guard, decide()
src/jev/             Decider interface, real Jev client (AI Gateway), keyword fake, question texts
src/store/           Store interface, Netlify Blobs with etag CAS, memory fallback, updateWithCas()
src/service/         orchestration over store + jev: context, window evaluation, classification (with claim), outcomes,
                     yield flag, jobs, batch step, hedge race, explanations. Functions import only from here, core, http, upstream.
src/upstream/        the simulated upstream being protected (fail %, latency, tail, abortable)
src/http/            request parsing, validation, JSON responses with the header contract
netlify/functions/   thin HTTP + scheduled handlers: protected, status, reset, jobs, job, tick, hello
public/              index.html, app.js, styles.css (no build step)
scripts/e2e.mjs      live-URL verification
tests/core/          unit + property tests per core module; tests/service/ for the hedge race
docs/                PLAN.md, control-plane.md, data-plane.md, RATIONALE.md
```

Dependency direction: functions → service → (core, jev, store, upstream, http); core imports nothing outside itself.

## Non-negotiable design invariants (tests must cover each)

1. Tier changes at most one step per 5 s window, in either direction.
2. Jev is advisory: it may raise the proposed tier, never lower it below the deterministic tier; confidence below threshold is ignored;
   any Jev failure, timeout, or budget exhaustion falls back to the deterministic policy and says so in `x-decider`.
3. Hedging fires only when all four gates pass (tier ≤ 1, critical pool ≥ 2, idempotent, safeToRetry ≥ 0.7). Never at HARD_THROTTLE or above.
4. Batch preemption happens only at chunk boundaries; the cursor is never lost; the aging guard prevents starvation.
5. Every response carries the header contract in `docs/data-plane.md` §5.
6. All shared state is per session namespace; one visitor's stress never leaks into another's view.

## Coding conventions

- TypeScript strict. No `any` in `src/core`. Core functions are pure: `(state, input, now) → { decision, nextState }`. Pass `now` explicitly; never call `Date.now()` inside core.
- Small modules with one responsibility. Prefer plain functions and data over classes.
- Errors: never swallow. Map every failure to a bounded outcome and a header value; log with a stable `event` field.
- Names: tiers and states are uppercase constants (`NORMAL`, `OPEN`, `PREEMPTED`); header names are lowercase `x-…`.
- No new runtime dependencies without a one-line justification in the PR/commit message. Current allowed: `@netlify/functions`, `@netlify/blobs`, `@typesafe-ai/sdk`.
- Keep the plan honest: when you change behaviour, update `docs/PLAN.md` and the relevant diagram in the same change.

## Security practices

- Never commit secrets. Netlify injects `TYPESAFE_*` and `NETLIFY_AI_GATEWAY_*`; do not copy them into files or logs. `.env*` is gitignored.
- Validate and clamp every query/body input server-side: `fail` ∈ [0,1], `latency` ≤ 2000, `tail` ∈ [0,1], `items` ≤ 5000, description ≤ 500 chars, session id `[A-Za-z0-9_-]{6,32}`.
- Only a bounded summary of user input reaches Jev (description ≤ 500 chars, numeric telemetry). Never forward headers, IPs, or raw bodies.
- Client id is `sha256(ip + user-agent)`; store no PII, no raw IPs.
- Idempotency gate for hedging is deterministic (GET or `Idempotency-Key`); Jev can only veto, never grant.
- Reset is per session and rate limited; there is no global reset.
- Public demo caps: global tokens/s per the tier table, Jev budget 60/min and 3000/day, upstream latency cap 2 s, step budget 3 s.
- CORS: same-origin only. No wildcard.
- Dependencies pinned; run `npm audit` before deploy and fix highs.

## Testing and verification policy (autonomous, no prompting needed)

- After every code change: run `npm run check` (typecheck, lint, format, unit + property tests). Fix failures before moving on. Do not report a change as done with anything red.
- After every deploy: run `/verify-deploy` (skill in `.claude/skills/verify-deploy`), which executes `scripts/e2e.mjs` against the production URL and checks the status endpoint, headers, tier ladder, breaker, preemption, hedging, and the Jev-off fallback.
- Use an independent subagent to verify, not the agent that made the change: spawn a `general-purpose` agent whose only job is to run the checks, read the real outputs, and report pass/fail with evidence (status codes, headers, timings). Treat its report as the source of truth.
- Stop only when the feature or fix matches what was actually requested, as verified by the checks above. If verification cannot run (e.g. deploy failed, AI Gateway not active yet), say exactly what could not be verified and why; never claim success.
- If a check fails, iterate: fix, re-run tests, redeploy, re-verify. Report the final outcome faithfully, including anything skipped.

## Skills

- Reuse before creating: check `.claude/skills/` and the enabled skill list first.
- Create a project skill when a workflow is repeated (deploy + verify, load test, transcript export). Keep skills short, imperative, and with explicit pass/fail criteria.
- Current: `verify-deploy` — deploy to production and prove it works end to end.

## Commands

```
npm install
npm run check        # typecheck + lint + format:check + test; must be green before any commit or deploy
npm run lint         # eslint (typescript-eslint type-checked rules); npm run lint:fix
npm run format       # prettier --write; npm run format:check
npm test             # vitest unit + property tests
npm run typecheck    # tsc --noEmit
npm run e2e -- <url> # scripts/e2e.mjs against a live URL
npm run deploy       # netlify deploy --prod (functions bundled fresh)
npm run dev          # netlify dev (AI Gateway proxies locally after the first prod deploy)
```

## Git

- Work on `main` for this take-home; small, descriptive commits. Do not push without being asked.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Deliverables checklist (assignment)

- [x] Deployed prototype URL, usable immediately in a browser and via curl: https://infra-guardian.netlify.app
- [x] Repo with this file, `docs/`, tests, README with curl examples (push when the owner says so)
- [ ] `docs/RATIONALE.md`: drafted; owner fills in time spent and the AI-usage section
- [ ] ~5 min video (owner records)
- [ ] AI transcripts exported and linked
