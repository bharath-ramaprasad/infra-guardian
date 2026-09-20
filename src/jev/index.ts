import { FakeDecider } from "./fake";
import { JevDecider } from "./real";
import type { Decider } from "./decider";

export * from "./decider";
export * from "./fake";
export * from "./real";

let cached: Decider | null = null;

/** Real Jev when the AI Gateway (or a TYPESAFE_API_KEY) is present and JEV_FAKE is not set; otherwise the fake. */
export function resolveDecider(): Decider {
  if (cached) return cached;
  const forceFake = process.env.JEV_FAKE === "1";
  const hasKey = Boolean(process.env.TYPESAFE_API_KEY);
  cached = !forceFake && hasKey ? new JevDecider() : new FakeDecider();
  return cached;
}
