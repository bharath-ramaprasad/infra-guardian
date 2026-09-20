---
name: verify-deploy
description: Deploy infra-guardian to Netlify production and prove the deployed service works end to end. Use after any change that should be live, or when asked to verify the live site.
---

# verify-deploy

Goal: a green, evidence-backed verification of the production deployment. Never report success without the evidence below.

## Steps
1. Preconditions: `npm run typecheck` and `npm test` are green. If not, stop and fix first.
2. Deploy: `npm run deploy` (netlify deploy --prod). Capture the production URL from the output.
3. Spawn an independent `general-purpose` subagent with this brief: "Run `npm run e2e -- <URL>` in the repo, then curl `<URL>/api/status?s=verify` and `<URL>/api/protected?s=verify` (POST, JSON body `{"description":"health check"}`). Report every status code, the full set of `x-*` and `retry-after` headers, timings, and the e2e script's pass/fail per scenario. Do not fix anything; report only."
4. Read the subagent's report against these pass criteria:
   - `GET /api/status` returns 200 JSON with `tier`, `breaker`, `pools`, `jev.budget`, `jev.last`.
   - Every `/api/protected` response has `x-tier`, `x-breaker`, `x-decider`, `x-priority`, `x-hedge`, `x-ratelimit-remaining`.
   - e2e scenarios all pass: burst → 429 + retry-after and tier climbs one step per window; `fail=1` → breaker open with fail-fast < 100 ms, then recovery walks down one step per window; batch job preempts within one chunk under a critical burst and resumes from its cursor; hedging fires only under the four gates; `jev=off` yields `x-decider: deterministic` with scenarios still passing.
   - `x-decider` is `jev` on at least one response when Jev is reachable. If it is never `jev`, report that the AI Gateway is not active (first prod deploy may be needed) and that the deterministic path is what was verified.
5. If any criterion fails: fix, re-run tests, redeploy, and repeat from step 3. Stop only when all pass or a blocker outside the repo is identified.
6. Final report: URL, commit SHA, pass/fail per criterion, anything skipped and why.
