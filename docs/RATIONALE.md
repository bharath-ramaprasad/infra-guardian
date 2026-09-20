# Design rationale

> Draft written with Claude Code from the design conversation. Sections marked **[owner]** need Bharath's own words and numbers before submission.

## Why this theme and this approach

Theme 3 asks for infrastructure that "degrades predictably under stress". A circuit breaker and rate limiter is the canonical answer, and that is exactly why a plain one would not be interesting: the algorithms are well known. The question I wanted to answer is what a typed decision model can add to a control loop without taking away the guarantees that make the loop trustworthy.

TypeSafe's Jev is a model that returns typed decisions with calibrated probabilities instead of text. That shape is unusually well suited to a control plane: a probability and a confidence are things code can gate on, clamp, and budget. So the design puts Jev where judgment is genuinely hard to hand-code, and keeps code in charge of everything that must be exact.

## What is non-obvious

1. **Jev is advisory, code is authoritative.** Jev can raise caution but never lower it below the deterministic rule. Its answers are ignored below a confidence threshold, its influence on the tier is clamped to one step per window, and it runs under a budget guard and an inner circuit breaker of its own. When any of that trips, the deterministic policy runs and the `x-decider` header says which exit was taken. The system is as safe with Jev unplugged as with it on, and you can verify that from curl by toggling `jev=off`.
2. **Priority means precedence, not survival.** Lower classes are not simply dropped under stress. Each class has a reserved token share, borrowing is allowed only while calm, and lower classes wait a bounded time for a token before they are refused. They degrade in latency first, then in availability. Critical requests never degrade until the breaker opens.
3. **Batch work is preempted, not killed.** For long, chunked, resumable work, dropping wastes everything done so far. Batch jobs here checkpoint a cursor per chunk. A critical request dipping into the critical reserve raises a yield flag; the job yields at the next chunk boundary and resumes from its cursor once pressure has been clear for a full window. An aging guard grants one chunk every ten seconds so it never starves. Preemption latency is bounded by one chunk.
4. **Hedging with four gates.** Critical requests get a delayed second copy after the rolling p50 latency, first response wins, loser aborted. Naive hedging amplifies the failure it is meant to hide, so it needs the tier to be calm, the critical pool to have headroom, the client to assert idempotency, and Jev not to veto on "safe to run twice". The critical class therefore has its own degradation order: it loses the hedge first, then the wait budget, then admission.
5. **Every response explains itself.** Tier, breaker, decider, class with probability, wait time, hedge outcome, and remaining tokens are headers. A reviewer can evaluate the whole system with curl.

## Key decisions and tradeoffs

- **Netlify over Vercel.** Jev is not on Vercel's free AI Gateway tier; on Netlify it is zero-config and bills to free credits. Netlify Blobs gives strong reads and etag compare-and-set, which is all the concurrency control this needs. Tradeoff: Blobs adds roughly 100 ms per round trip and the free plan's credit cap is a hard stop for the whole site, so the caps are deliberately low.
- **Serverless means cooperative preemption and a browser-driven job loop.** Functions have no long-running worker, so the page polls the step endpoint and a scheduled tick steps parked jobs every minute. Stated plainly, this is a good tradeoff for a demo; it is not a scheduler.
- **Per-visitor namespaces.** Shared state would let two reviewers stress each other's view. Every session id gets its own state, and reset is per session, so it can be public.
- **The safe-to-retry gate is a veto at 0.7, not a grant at 0.9.** Measured on the live model, Jev scores card charges near 0 and read-only fetches at 0.79 to 0.86. Because the client's idempotency key is the primary guard, treating Jev as a veto (block below 0.7) is the cleaner rule than demanding 0.9 certainty. One constant, easy to reverse.
- **Classification claim.** Concurrent identical requests used to each call Jev and burn the budget. A per-description claim in the session state means one caller classifies and the rest wait briefly for the answer.
- **Scale was cut on purpose.** A v1 design had leases, sharded counters, and per-instance telemetry keys. It was dropped for demo scope; the levers are listed below.

## What I would do with more time

- Move the OPEN fail-fast path to an Edge Function so an open breaker costs no function invocation.
- Shard the per-second counters and elect a per-window evaluator with a create-only lease, so the hot path never contends on one key.
- Swap the store interface to Redis if Blobs latency becomes the bottleneck; the core and tests would not change.
- Quorum hedging (2 of 3) for correctness checks against divergent replicas.
- Feed Jev the job description and the current queue when deciding resume order, not just deferability at submission.

## How AI was used **[owner]**

The plan, diagrams, code, tests, and this draft were produced with Claude Code across one session; the transcript is submitted alongside. The decisions above that were mine rather than the model's: choosing Jev as the policy layer instead of a generic LLM; insisting that batch work be preempted rather than dropped; adding hedged requests for the critical class; cutting scale to keep the prototype demoable; and pushing back on the initial two-hour estimate. **[owner: adjust, add what you overrode or rejected]**

## Time spent **[owner]**

Approximately **[owner: fill in]** hours, including design, build, deploy, and end-to-end testing against the live site.
