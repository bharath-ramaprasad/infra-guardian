import type { ClassifyAnswer, Decider, ScoreAnswer, StressInput } from "./decider";

// Keyword heuristics with the same answer shapes as Jev. Used in tests and local runs (JEV_FAKE=1).
// Deliberately crude so a reviewer can see the difference when the real model is on.

function has(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  return words.some((w) => t.includes(w));
}

export class FakeDecider implements Decider {
  readonly kind = "fake" as const;

  async classify(description: string): Promise<ClassifyAnswer> {
    const critical = has(description, ["payment", "checkout", "invoice", "phone", "waiting", "health", "confirm", "urgent", "login"]);
    const bulk = has(description, ["export", "report", "crawl", "batch", "nightly", "analytics", "backfill", "prefetch", "unattended"]);
    const probabilities = critical
      ? { critical: 0.86, standard: 0.12, bulk: 0.02 }
      : bulk
        ? { critical: 0.03, standard: 0.17, bulk: 0.8 }
        : { critical: 0.15, standard: 0.7, bulk: 0.15 };
    const priority = critical ? "critical" : bulk ? "bulk" : "standard";
    const unsafe = has(description, ["charge", "pay ", "payment", "transfer", "send", "email", "refund", "create", "delete"]);
    return { priority, probabilities, confidence: critical || bulk ? 0.82 : 0.66, safeToRetry: unsafe ? 0.08 : 0.93 };
  }

  async stress(i: StressInput): Promise<ScoreAnswer> {
    const s = i.summary;
    let score = 0;
    if (s.errorRate > 0.9 || (s.n > 0 && s.timeouts / s.n > 0.9)) score = 4;
    else if (s.errorRate >= 0.5 || s.timeouts >= 5) score = 3;
    else if (s.errorRate >= 0.2 || s.p95Ms >= 1200) score = 2;
    else if (s.errorRate >= 0.05 || s.p95Ms > i.previous.p95Ms * 1.5) score = 1;
    const probabilities: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0 };
    probabilities[String(score)] = 0.8;
    probabilities[String(Math.max(0, score - 1))] = (probabilities[String(Math.max(0, score - 1))] ?? 0) + 0.2;
    return { score, confidence: s.n >= 5 ? 0.8 : 0.4, probabilities };
  }

  async deferability(description: string): Promise<ScoreAnswer> {
    const soon = has(description, ["waiting", "now", "phone", "urgent", "asap", "customer"]);
    const later = has(description, ["nightly", "weekly", "unattended", "whenever", "backfill", "archive"]);
    const score = soon ? 0 : later ? 4 : 2;
    return { score, confidence: soon || later ? 0.85 : 0.5, probabilities: { [String(score)]: 0.85 } };
  }
}
