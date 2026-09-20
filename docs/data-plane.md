# Data plane

The data plane is every path that carries visitor traffic: interactive requests through the admission gates and an
optional hedged upstream call, batch job steps that process chunks until preempted, and status reads. It reads
control-plane state and writes only telemetry, client buckets, and job cursors. It never calls Jev on the health path.
The only inline Jev use is classification of a request or job description, and that answer is cached.

## 1. Interactive request hot path

```mermaid
flowchart TB
  IN([POST /api/protected?s=session&fail=&latency=&tail=<br/>body: description, idempotencyKey])
  SNAP["Tier snapshot<br/>instance cache 1 s, else strong read"]
  BRK{Breaker OPEN?}
  FAST([503 circuit-open<br/>no store write, no upstream<br/>x-breaker: open])
  CLS["Priority class<br/>client cache 60 s, else Jev choice"]
  POOL["Take token from class pool<br/>borrow from others if tier ≤ 1"]
  GOT{Token?}
  YIELD["If critical and pool empty:<br/>set yieldRequestedAt = now"]
  WAIT["Wait and retry<br/>critical 0 ms · standard 500 ms · bulk 1500 ms<br/>budget is probability-weighted"]
  EXP{Budget exhausted?}
  REJ([429 + Retry-After<br/>503 shed at tier ≥ 3<br/>x-wait-ms, x-ratelimit-reason])
  HEDGE["Hedge gates, see section 2<br/>tier ≤ 1 · pool ≥ 2 · idempotent · safeToRetry ≥ 0.7"]
  UP["Simulated upstream<br/>timeout 2 s, abortable"]
  REC["Record outcome<br/>telemetry ring, client history<br/>CAS ≤ 3 retries"]
  OUT([200 or 502 with headers<br/>x-tier x-breaker x-decider x-priority<br/>x-wait-ms x-hedge x-ratelimit-remaining])

  IN --> SNAP --> BRK
  BRK -->|yes| FAST
  BRK -->|no| CLS --> POOL --> GOT
  GOT -->|yes| HEDGE --> UP --> REC --> OUT
  GOT -->|no| YIELD --> WAIT --> EXP
  EXP -->|yes| REJ
  EXP -->|no, retry| POOL
```

## 2. Hedged upstream call, critical class only

Delayed 1:2 hedge. The second copy is sent only if the first has not returned within 1.5× the rolling p50 upstream latency (300 ms until there are five samples), so ordinary requests never hedge and tail requests do.
The first response wins, the loser is aborted, and the simulated upstream honours the abort.

```mermaid
flowchart LR
  GATES{All four gates pass?<br/>tier ≤ 1 · critical pool ≥ 2<br/>GET or Idempotency-Key · safeToRetry ≥ 0.7}
  SINGLE([Single call<br/>x-hedge: gated-reason])
  C1["Copy 1<br/>consume 1 token"]
  TIMER["Wait 1.5 × p50<br/>default 300 ms, floor 50, cap 2 s"]
  BACK{Copy 1 returned?}
  ONE([x-hedge: armed<br/>copy 2 never needed])
  C2["Copy 2<br/>consume 1 token"]
  RACE["First response wins"]
  ABORT["Abort loser<br/>AbortController"]
  WIN([x-hedge: fired-won-by-1 or 2<br/>record both outcomes])

  GATES -->|no| SINGLE
  GATES -->|yes| C1 --> TIMER --> BACK
  BACK -->|yes| ONE
  BACK -->|no| C2 --> RACE --> ABORT --> WIN
```

Critical-class degradation order under pressure: the hedge is lost first through the pool gate, then the wait budget,
then admission, then the breaker fails fast. Hedging can never fire at HARD_THROTTLE or above, so it cannot amplify an
upstream slowdown.

## 3. Batch job step path

The browser drives the loop by polling the step endpoint. The scheduled tick also steps parked jobs so they finish
without a tab. Each step processes chunks until a 3 s budget is spent or a preemption condition appears.

```mermaid
flowchart TB
  IN([POST /api/jobs/:id/step<br/>browser poll or tick])
  LOAD["Strong read job/id with etag<br/>and tier snapshot"]
  ST{state is RUNNING<br/>or resumable?}
  PARK([Return progress unchanged<br/>x-job: preempted or queued])
  CHK{Preempt check before chunk:<br/>tier ≥ 2 · critical pool under its 25% reserve<br/>· yield within 2 s}
  PRE([Save cursor, state = PREEMPTED<br/>CAS write, x-job: preempted])
  TOK["Take 1 bulk token<br/>chunksPerSec by tier"]
  CHUNK["Process one chunk via upstream<br/>≤ 200 ms"]
  CUR["cursor += chunkSize<br/>record outcome in telemetry"]
  MORE{items left and<br/>step budget under 3 s?}
  SAVE["CAS write job/id"]
  DONE([state = DONE if cursor = items<br/>return progress])

  IN --> LOAD --> ST
  ST -->|no| PARK
  ST -->|yes| CHK
  CHK -->|preempt| PRE
  CHK -->|clear| TOK --> CHUNK --> CUR --> MORE
  MORE -->|yes| CHK
  MORE -->|no| SAVE --> DONE
```

## 4. Storage layout per session namespace

All keys are prefixed by the visitor's session id, so reviewers never see each other's stress. Writes use
compare-and-set on the Blobs etag with at most three retries.

```mermaid
flowchart LR
  REQ["Interactive request"]
  STEP["Batch step"]
  EVAL["Window evaluator"]
  SUB["Job submit / cancel"]

  SVC[("session/svc/state<br/>tier · breaker · cooldown · pools<br/>telemetry ring 50 · lastWindow<br/>yieldRequestedAt · jevBudget · jevOff")]
  CLI[("session/client/hash<br/>bucket · history 20<br/>cachedPriority · cachedAt")]
  JOB[("session/job/id<br/>items · cursor · state · deferability<br/>submittedAt · resumeAfter · resumes")]
  IDX[("session/jobs/index<br/>job ids for the status page")]
  YLD[("session/yield<br/>at: last critical pressure<br/>plain write, no CAS")]

  REQ -->|telemetry, pools, yield, CAS| SVC
  REQ -->|bucket, history, CAS| CLI
  STEP -->|cursor, state, CAS| JOB
  STEP -->|telemetry, bulk tokens, CAS| SVC
  EVAL -->|tier, breaker, budget, CAS| SVC
  SUB --> JOB
  SUB --> IDX
  REQ -->|critical could not be admitted promptly| YLD
  YLD -.->|merged before every preempt check| STEP
```

The yield flag has its own key on purpose: under a burst the main state key is contended, and a critical request that loses the
admission race is exactly the signal batch work must not miss. A plain last-writer-wins write cannot be starved.

## 5. Response header contract

Every data-plane response carries these, so the behaviour is inspectable from curl alone.

| Header                  | Values                                                                                   |
|-------------------------|------------------------------------------------------------------------------------------|
| `x-tier`                | `0` … `4` with name, for example `2 HARD_THROTTLE`                                       |
| `x-breaker`             | `closed` · `half-open` · `open`                                                          |
| `x-decider`             | `jev` · `deterministic` · `jev-bypassed-budget` · `jev-bypassed-lowconf` · `jev-error`  |
| `x-priority`            | `critical` · `standard` · `bulk`, with probability, for example `critical p=0.91`        |
| `x-wait-ms`             | milliseconds spent waiting for a token                                                   |
| `x-hedge`               | `off` · `gated-<reason>` · `armed` · `fired-won-by-1` · `fired-won-by-2`                 |
| `x-ratelimit-remaining` | tokens left in the class pool                                                            |
| `x-ratelimit-reason`    | `pool-empty` · `shed` · `contention`                                                     |
| `retry-after`           | seconds, on 429 and 503                                                                  |
| `x-store`               | `ok` · `degraded` when Blobs is unreachable and the in-memory fallback is in use         |
| `x-job`                 | on job endpoints: `running` · `preempted` · `queued` · `done`                            |
