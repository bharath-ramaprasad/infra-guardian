# Design rationale

> Written with Claude Code from the design conversation and reviewed by the owner.

## Why this theme and this approach

Theme 3 asks for infrastructure that "degrades predictably under stress". A circuit breaker and rate limiter is the canonical answer, and that is exactly why a plain one would not be interesting: the algorithms are well known. The question I wanted to answer is what a typed decision model can add to a control loop without taking away the guarantees that make the loop trustworthy.

TypeSafe's Jev is a model that returns typed decisions with calibrated probabilities instead of text. That shape is unusually well suited to a control plane: a probability and a confidence are things code can gate on, clamp, and budget. So the design puts Jev where judgment is genuinely hard to hand-code, and keeps code in charge of everything that must be exact.

## What is non-obvious

1. **Jev is advisory, code is authoritative.** Jev can raise caution but never lower it below the deterministic rule. Its answers are ignored below a confidence threshold, its influence on the tier is clamped to one step per window, and it runs under a budget guard and an inner circuit breaker of its own. When any of that trips, the deterministic policy runs and the `x-decider` header says which exit was taken. The system is as safe with Jev unplugged as with it on, and you can verify that from curl by toggling `jev=off`.
2. **Priority means precedence, not survival.** Lower classes are not simply dropped under stress. Each class has a reserved token share, borrowing is allowed only while calm, and lower classes wait a bounded time for a token before they are refused. They degrade in latency first, then in availability. Critical requests never degrade until the breaker opens.
3. **Batch work is preempted, not killed.** For long, chunked, resumable work, dropping wastes everything done so far. Batch jobs here checkpoint a cursor per chunk. A critical request dipping into the critical reserve raises a yield flag; the job yields at the next chunk boundary and resumes from its cursor once pressure has been clear for a full window. An aging guard grants one chunk every ten seconds so it never starves. Preemption latency is bounded by one chunk.
4. **Hedging with four gates.** Critical requests get a second copy only if the first has not returned within 1.5× the rolling p50 latency (300 ms until there are samples); first response wins, loser aborted. Naive hedging amplifies the failure it is meant to hide, so it needs the tier to be calm, the critical pool to have headroom, the client to assert idempotency, and Jev not to veto on "safe to run twice". The critical class therefore has its own degradation order: it loses the hedge first, then the wait budget, then admission.
5. **Every response explains itself.** Tier, breaker, decider, class with probability, wait time, hedge outcome, and remaining tokens are headers. A reviewer can evaluate the whole system with curl.

## Key decisions and tradeoffs

- **Netlify over Vercel.** Jev is not on Vercel's free AI Gateway tier; on Netlify it is zero-config and bills to free credits. Netlify Blobs gives strong reads and etag compare-and-set, which is all the concurrency control this needs. Tradeoff: Blobs adds roughly 100 ms per round trip and the free plan's credit cap is a hard stop for the whole site, so the caps are deliberately low.
- **Serverless means cooperative preemption and a browser-driven job loop.** Functions have no long-running worker, so the page polls the step endpoint and a scheduled tick steps parked jobs every minute. Stated plainly, this is a good tradeoff for a demo; it is not a scheduler.
- **Per-visitor namespaces.** Shared state would let two reviewers stress each other's view. Every session id gets its own state, and reset is per session, so it can be public.
- **The safe-to-retry gate is a veto at 0.7, not a grant at 0.9.** Measured on the live model, Jev scores card charges near 0 and read-only fetches at 0.79 to 0.86. Because the client's idempotency key is the primary guard, treating Jev as a veto (block below 0.7) is the cleaner rule than demanding 0.9 certainty. One constant, easy to reverse.
- **Classification claim.** Concurrent identical requests used to each call Jev and burn the budget. A per-description claim in the session state means one caller classifies and the rest wait briefly for the answer.
- **Scale was cut on purpose.** A v1 design had leases, sharded counters, and per-instance telemetry keys. It was dropped for demo scope; the levers are listed below.

## What I would do with more time

**Make it a primitive any infra engineer can plug in, not a demo.** The code is already shaped for it, and the honest
plan has three steps.

What carries over unchanged: the policy engine in `src/core` (pure, clock-free, property-tested), the two seams that
are already interfaces (a four-method store with compare-and-set, a three-method decider), and the product surface
(the header contract, the `why`/`state` explanations, the job event history).

What must change: the runtime model. The demo does one strong store read and two compare-and-set writes per request
(about 100–300 ms) and keys state per visitor session. A gateway hot path needs microseconds and state keyed per
protected dependency. So the service layer becomes in-process memory as the primary state with an optional shared
store (Redis) for cross-instance agreement on the tier, which is the leases-and-sharded-counters design that was cut
from v1 for demo scope. The simulated upstream becomes the function you wrap, and the browser-driven job loop becomes
the user's own worker asking the guard before each chunk.

1. **Library.** `createGuard({ name, decider, store })` exposing `admit(request)`, `wrap(fn)` to protect an outbound
   call (the Resilience4j shape), `middleware()` for Hono and Express to protect inbound routes, `batch(job, chunkFn)`
   for cooperative preemption inside the caller's worker, and `on(event)` so tier changes, breaker trips, preemptions,
   and Jev bypasses feed Prometheus or OpenTelemetry. Ships with an in-process memory store and a Redis store. The
   current demo becomes the first consumer and re-runs the same 19 live scenarios, which is the proof of pluggability.
2. **Sidecar.** The same guard behind three endpoints (admit, outcome, status) in a container, with an Envoy
   `ext_authz` adapter. That covers Go, Python, and Java services and any gateway that can call out, without a port of
   the library per language.
3. **Claude Code skill.** An `integrate-guardian` skill that reads a codebase, finds outbound dependency calls and
   inbound routes, wires the wrapper or middleware with sensible class descriptions, and runs the verification. That is
   the agent primitive an engineer would reach for; it depends on the library existing first.

Jev's role survives the move and gets more interesting: in a real gateway the descriptions come from route metadata
and request shape rather than typed text, the stress score reads real telemetry, and deferability can consider the
live queue when ordering resumes, not just the description at submission.

Smaller items on the same path: move the OPEN fail-fast branch to an edge function so an open breaker costs no
invocation; quorum hedging (2 of 3) for correctness checks against divergent replicas.

## How AI was used

I used Claude Code in the desktop app for the whole project, and the transcript is submitted alongside. The way I
worked it was design first, build second, and I kept the judgment calls with me.

**Design before code.** The first hour was a conversation, not a build. I asked for a plan, pushed on it, and
had the architecture drawn as control-plane and data-plane diagrams before a single file existed. That is where most
of the decisions below were made, and the plan became the spec the code was held to.

**An autonomous verification loop, by policy.** I wrote the working agreement (`CLAUDE.md`) so that after every change
the model runs typecheck, lint, format, and tests, and after every deploy an *independent* agent runs the live
end-to-end suite and reports evidence, not the agent that made the change. I did not accept "done" without that
report. The loop found the bugs that mattered: a cached Blobs client whose token expired on warm instances, a cached
Jev client that started answering 401 the same way, a classification stampede under bursts, a hedge that fired on
ordinary requests, and an evaluation window that missed paused bursts. Several of those only appear on a warm
production instance; unit tests would never have caught them.

**Decisions that were mine, not the model's:**

- Building on Jev at all. The model initially did not know what Jev was; I pointed it at TypeSafe and required a
  platform with Jev on a free tier. The framing "Jev advises, code decides" came out of that conversation and I kept
  the model to it.
- Preempting batch work instead of dropping it. The model first argued against preemption; I clarified I meant
  chunked batch jobs, not HTTP calls, and that reframing produced the checkpoint-and-yield design and the aging guard.
- Hedged requests for the critical class. I proposed it (as "anycast"; the model corrected the term and added the
  four gates so it cannot amplify a slowdown).
- Cutting scale to keep the prototype demoable, and rejecting the model's claim that my scope was too big for the
  time; I dropped only two items.
- Per-request reasoning as a first-class feature: the details card, the plain-language `why` on every response, and
  the job lifecycle table with reasons. I asked for these after seeing the first working version; the model had
  stopped at headers.
- Package structure, lint and format gates, and a narrated demo with every capability shown with and without Jev.

**Decisions the model made on its own that I reviewed and kept:** the Jev timeout at 800 ms after measuring gateway
latency; treating the safe-to-retry answer as a veto at 0.7 rather than a grant at 0.9, after measuring what Jev
actually scores for read-only fetches versus card charges; and reshaping one demo scene when the recording showed
that with Jev off there is no critical class, so the honest demonstration is tier-driven preemption.

**What I would tell someone doing this.** Make the model write the plan and the invariants first, put the
verification policy in the repo so it cannot be skipped, and insist that verification be done by a different agent
with evidence. The model is very good at the build; the value I added was in what to build, what not to, and not
believing green until an independent run said so.

## Time spent

It took about 3.5 hours of my time on Sunday, 20 September 2026: about one hour of design conversation (plan, diagrams,
scope), about two hours of implementing and building with the verification loop running against production, and about
half an hour on the reviewer-facing work that followed: the explanations, the job lifecycle view, the quality gates, and
the narrated demo video. That counts
the time I was at the desk directing, reviewing, and deciding; it does not count stretches where the model was running
a deploy, a live test suite, or a recording while I was away. It is over the two-hour target and under the eight-hour
limit, and the extra time went into verification and explainability on purpose.
