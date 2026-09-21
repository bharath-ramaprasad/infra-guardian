import { TypeSafeClient, choice, noul, score, type EntryType } from "@typesafe-ai/sdk";
import { JEV_BUDGET } from "../core";
import { QUESTIONS, type ClassifyAnswer, type Decider, type ScoreAnswer, type StressInput } from "./decider";

// Real Jev through Netlify's AI Gateway. One systemOne call per decision, hard per-attempt timeout, no SDK retries:
// retries are the guard's job, and a slow answer is worth less than a fast deterministic one.

/** Strip interface types down to plain JSON for the SDK's EntryType. */
function asJson(v: unknown): EntryType {
  return JSON.parse(JSON.stringify(v)) as EntryType;
}

export class JevDecider implements Decider {
  readonly kind = "jev" as const;
  private readonly client = new TypeSafeClient({ timeout: JEV_BUDGET.timeoutMs, retry: { maxRetries: 0 } });

  private opts(signal?: AbortSignal) {
    return signal ? { signal, timeout: JEV_BUDGET.timeoutMs } : { timeout: JEV_BUDGET.timeoutMs };
  }

  async classify(description: string, signal?: AbortSignal): Promise<ClassifyAnswer> {
    const { answers } = await this.client.systemOne(
      {
        state: { request: { description: description.slice(0, 500) } },
        questions: {
          priority: choice(QUESTIONS.priority.instructions, QUESTIONS.priority.criteria),
          safeToRetry: noul(QUESTIONS.safeToRetry.instructions, QUESTIONS.safeToRetry.criteria),
        },
      },
      this.opts(signal),
    );
    const p = answers.priority;
    return {
      priority: p.choice,
      probabilities: { critical: p.probabilities.critical, standard: p.probabilities.standard, bulk: p.probabilities.bulk },
      confidence: p.confidence,
      safeToRetry: answers.safeToRetry.noul,
    };
  }

  async stress(input: StressInput, signal?: AbortSignal): Promise<ScoreAnswer> {
    const { answers } = await this.client.systemOne(
      {
        state: asJson({
          currentTier: input.tier,
          lastWindow: input.summary,
          previousWindow: input.previous,
          recentSamples: input.recent.slice(-15),
        }),
        questions: { stress: score(QUESTIONS.stress.instructions, QUESTIONS.stress.criteria) },
      },
      this.opts(signal),
    );
    const s = answers.stress;
    return { score: s.score, confidence: s.confidence, probabilities: { ...s.probabilities } };
  }

  async deferability(description: string, signal?: AbortSignal): Promise<ScoreAnswer> {
    const { answers } = await this.client.systemOne(
      {
        state: { job: { description: description.slice(0, 500) } },
        questions: { deferability: score(QUESTIONS.deferability.instructions, QUESTIONS.deferability.criteria) },
      },
      this.opts(signal),
    );
    const s = answers.deferability;
    return { score: s.score, confidence: s.confidence, probabilities: { ...s.probabilities } };
  }
}
