import type { Priority } from "../core";
import type { TelemetrySummary } from "../core";

// The Decider is the only thing that talks to Jev. Real and fake implementations share this shape.

export interface ClassifyAnswer {
  readonly priority: Priority;
  readonly probabilities: Readonly<Record<Priority, number>>;
  readonly confidence: number;
  readonly safeToRetry: number;
}

export interface ScoreAnswer {
  readonly score: number;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface StressInput {
  readonly tier: number;
  readonly summary: TelemetrySummary;
  readonly previous: TelemetrySummary;
  readonly recent: ReadonlyArray<{ ok: boolean; latencyMs: number; timeout: boolean }>;
}

export interface Decider {
  readonly kind: "jev" | "fake";
  classify(description: string, signal?: AbortSignal): Promise<ClassifyAnswer>;
  stress(input: StressInput, signal?: AbortSignal): Promise<ScoreAnswer>;
  deferability(description: string, signal?: AbortSignal): Promise<ScoreAnswer>;
}

export const QUESTIONS = {
  priority: {
    instructions: "Classify the priority of this API request for load shedding. Under stress, lower classes are shed first.",
    criteria: {
      critical:
        "Health checks, payments, order or booking confirmations, a person actively waiting on the result, idempotent retries of something that already succeeded",
      standard: "Ordinary interactive user requests with no special urgency",
      bulk: "Exports, reports, crawls, prefetch, backfills, analytics, batch work, or anything marked low priority or unattended",
    },
  },
  safeToRetry: {
    instructions:
      "Is it safe to execute this request more than once, so a duplicate copy could be sent to reduce latency? Money movement, sending messages, or anything that must happen exactly once is not safe.",
    criteria: {
      true: "Read-only, idempotent, or naturally deduplicated",
      false: "Has side effects that must not repeat: charges, transfers, sends, creates without an idempotency key",
    },
  },
  stress: {
    instructions:
      "How stressed is the upstream service, given the last window of outcomes, the previous window, and the raw recent samples? Judge the trend, not just the latest number.",
    criteria: [
      "Healthy: errors under 5%, latency stable",
      "Warming: latency rising or a few errors, trend flat",
      "Degrading: errors 20 to 50% or p95 near the timeout, trend worsening",
      "Failing: majority errors or timeouts, still worsening",
      "Down: nearly all calls fail or time out",
    ],
  },
  deferability: {
    instructions: "How deferrable is this batch job? Lower means someone needs it sooner.",
    criteria: [
      "A person is waiting on the result right now",
      "Needed within minutes",
      "Needed within the hour",
      "Needed today",
      "Unattended, any time is fine",
    ],
  },
} as const;
