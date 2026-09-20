# Control plane

The control plane decides *policy*: what tier the system is in, whether the breaker is open, which batch jobs may run,
and how much the Jev decision model is allowed to influence any of that. It never serves visitor traffic directly.
Every control-plane output is a small piece of state in one Blobs record per session namespace (`<session>/svc/state`)
that the data plane reads.

Design rule shared by all five diagrams: **Jev is advisory, code is authoritative.** Jev may make the system more
cautious, never less safe. Its influence is gated by confidence, bounded by a one-step clamp per window, and budgeted.

## 1. Components and control signals

```mermaid
flowchart LR
  subgraph Triggers
    REQ["Any data-plane request<br/>that sees a new 5 s window"]
    TICK["Scheduled tick<br/>every minute, idle recovery"]
    RESET["POST /api/reset<br/>per session, 1 per 10 s"]
  end

  subgraph EVAL["Window evaluator (runs inside a CAS update)"]
    TEL["Telemetry ring<br/>last 50 upstream outcomes"]
    DET["Deterministic tier<br/>error %, p95, timeouts"]
    MERGE["Merge and clamp<br/>max(det, jev if confident)<br/>then ±1 step vs current"]
    BRK["Breaker state machine<br/>CLOSED / HALF_OPEN / OPEN"]
    SCHED["Batch scheduler<br/>resume order, aging guard"]
  end

  subgraph ORACLE["Policy oracle"]
    GUARD["Jev budget guard<br/>60/min, 3000/day<br/>3 errors → skip 30 s"]
    JEV["TypeSafe Jev via Netlify AI Gateway<br/>stress · priority · deferability · safeToRetry"]
  end

  STATE[("session/svc/state<br/>tier · breaker · pools · telemetry<br/>yieldRequestedAt · jevBudget · lastWindow")]

  REQ --> TEL
  TICK --> TEL
  RESET -->|rewrite defaults| STATE
  TEL --> DET --> MERGE
  MERGE -.->|count call| GUARD
  GUARD -->|allowed| JEV
  JEV -->|stress + confidence| MERGE
  GUARD -.->|bypassed: deterministic only| MERGE
  MERGE --> BRK
  MERGE -->|CAS write, ≤3 retries| STATE
  BRK --> STATE
  STATE --> SCHED
  SCHED -->|resume / park jobs| STATE
```

## 2. Tier ladder and breaker state machine

Tiers move at most one step per 5 s window in either direction. The breaker owns tier 4.

```mermaid
stateDiagram-v2
  direction LR
  NORMAL: 0 NORMAL
  SOFT: 1 SOFT_THROTTLE
  HARD: 2 HARD_THROTTLE
  SHED: 3 SHED
  OPEN: 4 OPEN (breaker)
  HALF: HALF_OPEN (one probe)

  [*] --> NORMAL
  NORMAL --> SOFT: escalate
  SOFT --> HARD: escalate
  HARD --> SHED: escalate
  SHED --> OPEN: escalate while at 3
  SOFT --> NORMAL: 2 clean windows
  HARD --> SOFT: 2 clean windows
  SHED --> HARD: 2 clean windows
  OPEN --> HALF: cooldown 10 s, doubling, cap 60 s
  HALF --> SHED: probe succeeds
  HALF --> OPEN: probe fails, cooldown doubles

  note right of SHED
    escalate = error rate ≥ 50% (n ≥ 10)
    or p95 ≥ 1500 ms or timeouts ≥ 5 in window
    or Jev stress with confidence ≥ 0.6
  end note
```

## 3. Window evaluation sequence

```mermaid
flowchart TB
  START([Caller notices lastWindow < currentWindow])
  READ["Strong read session/svc/state with etag"]
  STALE{Still stale?}
  SKIP([Another caller already evaluated: use theirs])
  DET["Deterministic tier from telemetry ring"]
  BUD{Jev budget and inner breaker OK?}
  CALL["Jev systemOne: stress<br/>800 ms timeout"]
  CONF{confidence ≥ 0.6?}
  MERGE["proposal = max(det, jevTier)"]
  CLAMP["tier = clamp(proposal, cur−1, cur+1)"]
  BRK["Advance breaker<br/>cooldown, half-open, probe result"]
  JOBS["Batch scheduler<br/>resume if tier ≤ 1 and no yield 2 s<br/>aging guard 1 chunk / 10 s"]
  CAS{CAS write with etag}
  DONE(["Publish: decider = jev, deterministic, or jev-bypassed"])
  RETRY([Retry ≤ 3, then serve with last read])

  START --> READ --> STALE
  STALE -->|no| SKIP
  STALE -->|yes| DET --> BUD
  BUD -->|yes| CALL
  BUD -->|no: jevTier = none| MERGE
  CALL -->|answer| CONF
  CALL -->|timeout or error: count against inner breaker| MERGE
  CONF -->|yes: jevTier = round score| MERGE
  CONF -->|no: jevTier = none| MERGE
  MERGE --> CLAMP --> BRK --> JOBS --> CAS
  CAS -->|ok| DONE
  CAS -->|etag mismatch| RETRY
  RETRY -.-> READ
```

## 4. Jev decision cascade

Every Jev answer, for all four questions, passes through the same cascade. The `x-decider` header reports which exit was taken.

```mermaid
flowchart TB
  NEED([Decision needed:<br/>priority · stress · deferability · safeToRetry])
  OFF{Session flag jev=off?}
  CACHE{Cached answer fresh?<br/>priority 60 s per client · stress 5 s}
  BUD{Budget under 60/min and 3000/day?}
  IBRK{Inner breaker closed?<br/>3 consecutive errors open it 30 s}
  CALL["systemOne with 800 ms timeout"]
  OK{Answer received?}
  CONF{confidence ≥ threshold?<br/>0.6 general · 0.7 safeToRetry}
  USE([Use Jev answer<br/>x-decider: jev])
  D1([Deterministic default<br/>x-decider: deterministic])
  D2([x-decider: jev-bypassed-budget])
  D3([x-decider: jev-error])
  D4([x-decider: jev-bypassed-lowconf])

  NEED --> OFF
  OFF -->|yes| D1
  OFF -->|no| CACHE
  CACHE -->|yes| USE
  CACHE -->|no| BUD
  BUD -->|no| D2
  BUD -->|yes| IBRK
  IBRK -->|open| D3
  IBRK -->|closed| CALL --> OK
  OK -->|timeout, 5xx, 429| D3
  OK -->|yes| CONF
  CONF -->|no| D4
  CONF -->|yes| USE
```

Deterministic defaults when Jev is bypassed: priority is `standard` (never `critical`), stress is the deterministic tier
only, deferability is level 2, and safeToRetry is false, which disables hedging.

## 5. Batch job lifecycle

```mermaid
stateDiagram-v2
  direction LR
  QUEUED: QUEUED (deferability scored)
  RUNNING: RUNNING (cursor advances per chunk)
  PREEMPTED: PREEMPTED (cursor saved, resumeAfter set)

  [*] --> QUEUED
  QUEUED --> RUNNING: tier ≤ 1 and no yield in 2 s
  RUNNING --> PREEMPTED: before any chunk, if tier ≥ 2 or critical pool under its 25% reserve or yield within 2 s
  PREEMPTED --> RUNNING: tier ≤ 1 for a full window and no yield 2 s, lowest deferability first, 0–500 ms stagger
  PREEMPTED --> RUNNING: aging guard, 1 chunk per 10 s unless tier is 4
  RUNNING --> DONE: cursor = items
  QUEUED --> CANCELLED: cancel
  RUNNING --> CANCELLED: cancel
  PREEMPTED --> CANCELLED: cancel
  DONE --> [*]
  CANCELLED --> [*]
```

Guarantees the control plane enforces:

- Preemption latency is at most one chunk, about 200 ms of upstream time.
- A preempted job never loses work, never starves thanks to the aging guard, and always finishes once pressure clears.
- Tier changes are visible one step at a time, with no cliff edges.
- Jev outages, budget exhaustion, and low confidence all degrade to the deterministic policy, with a header saying so.
