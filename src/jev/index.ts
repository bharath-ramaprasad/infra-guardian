import { FakeDecider } from "./fake";
import { JevDecider } from "./real";
import type { Decider } from "./decider";

export * from "./decider";
export * from "./fake";
export * from "./real";

const fake = new FakeDecider();

/**
 * Real Jev when the AI Gateway (or a TYPESAFE_API_KEY) is present and JEV_FAKE is not set; otherwise the fake.
 * Resolved per invocation on purpose: the gateway credential the runtime injects is short-lived, and a decider
 * cached across invocations on a warm instance eventually answers 401 (seen in production as AuthenticationError).
 */
export function resolveDecider(): Decider {
  const forceFake = process.env.JEV_FAKE === "1";
  const hasKey = Boolean(process.env.TYPESAFE_API_KEY);
  return !forceFake && hasKey ? new JevDecider() : fake;
}
