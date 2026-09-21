import {
  TIER_NAMES,
  THRESHOLDS,
  WAIT_BUDGET_MS,
  cooldownRemainingMs,
  tierSpec,
  type Admission,
  type ClassCacheEntry,
  type ServiceState,
} from "../core";
import type { UpstreamParams, UpstreamResult } from "../upstream";

// Plain-language reasons for a decision. Built from the same state the decision used, so it cannot drift from it.

export function explainClass(cls: ClassCacheEntry): string[] {
  const p = cls.probabilities[cls.priority] ?? 0;
  const out: string[] = [];
  switch (cls.decider) {
    case "jev":
      out.push(`Jev classified this request as ${cls.priority} (p=${p.toFixed(2)}, confidence ${cls.confidence.toFixed(2)}).`);
      break;
    case "jev-bypassed-lowconf":
      out.push(
        `Jev answered with confidence ${cls.confidence.toFixed(2)}, below the 0.6 threshold, so the request was treated as standard. Uncertainty never buys priority.`,
      );
      break;
    case "jev-bypassed-budget":
      out.push("Jev was not asked: the session's Jev budget is exhausted, so the deterministic default (standard) applied.");
      break;
    case "jev-error":
      out.push(
        "Jev timed out or errored, so the deterministic default (standard) applied. Three errors in a row open the inner breaker for 30 s.",
      );
      break;
    case "deterministic":
      out.push("Jev is off for this session; the deterministic default (standard) applied.");
      break;
  }
  if (cls.decider === "jev")
    out.push(`Safe to run twice: ${cls.safeToRetry.toFixed(2)} (hedging needs at least 0.7 and an idempotency key).`);
  return out;
}

export function explainTier(state: ServiceState, now: number): string[] {
  const out: string[] = [];
  const spec = tierSpec(state.tier);
  out.push(
    `Tier is ${state.tier} ${spec.name}: ${spec.tokensPerSec} tokens/s split critical ${Math.round(spec.shares.critical * 100)}% / standard ${Math.round(spec.shares.standard * 100)}% / bulk ${Math.round(spec.shares.bulk * 100)}%, borrowing ${spec.borrowing ? "on" : "off"}, batch ${spec.batchChunksPerSec} chunks/s.`,
  );
  const last = state.tierHistory[state.tierHistory.length - 1];
  if (last)
    out.push(
      `Last change ${Math.round((now - last.at) / 1000)} s ago: ${last.from} → ${last.to} (${last.decider}): ${last.reasons.join("; ")}.`,
    );
  if (state.lastEvaluation)
    out.push(
      `Last window (${state.lastEvaluation.samples} samples, ${Math.round((now - state.lastEvaluation.at) / 1000)} s ago): ${state.lastEvaluation.signal}${state.lastEvaluation.reasons.length ? ", " + state.lastEvaluation.reasons.join("; ") : ""}.`,
    );
  if (state.breaker.state === "OPEN")
    out.push(
      `Breaker is OPEN: every call fails fast without touching upstream. Next probe in ${Math.ceil(cooldownRemainingMs(state.breaker, now) / 1000)} s (cooldown ${state.breaker.cooldownMs / 1000} s).`,
    );
  if (state.breaker.state === "HALF_OPEN")
    out.push(
      "Breaker is HALF_OPEN: exactly one probe request goes to upstream; success reopens the ladder at SHED, failure doubles the cooldown.",
    );
  out.push(
    `Escalation rule: error rate ≥ ${THRESHOLDS.errorRate * 100}% over ≥ ${THRESHOLDS.minSamples} calls, or p95 ≥ ${THRESHOLDS.p95Ms} ms, or ≥ ${THRESHOLDS.timeouts} timeouts in a 5 s window. De-escalation after ${THRESHOLDS.cleanWindowsToRecover} clean windows. One step per window either way; Jev can raise the proposal, never lower it.`,
  );
  return out;
}

export function explainAdmission(
  state: ServiceState,
  admission: Admission,
  cls: ClassCacheEntry,
  waitedMs: number,
  budgetMs: number,
  contention: boolean,
): string[] {
  const out: string[] = [];
  if (contention) {
    out.push(
      "Rejected with 429 contention: this request lost the compare-and-set race for the session state four times. Under a burst that is itself a pressure signal; retry after 1 s.",
    );
    return out;
  }
  switch (admission.kind) {
    case "fail-fast":
      out.push(
        `Rejected with 503 circuit-open: the breaker is ${state.breaker.state}, so no upstream call was made. Retry after ${Math.ceil(admission.retryAfterMs / 1000)} s.`,
      );
      break;
    case "reject":
      if (admission.reason === "shed")
        out.push(
          `Rejected with 503 shed: at tier ${state.tier} ${TIER_NAMES[state.tier]} the ${cls.priority} class has no token share at all.`,
        );
      else
        out.push(
          `Rejected with 429: the ${cls.priority} pool was empty${tierSpec(state.tier).borrowing ? " and no other pool had a spare token to borrow" : " and borrowing is off at this tier"}. Waited ${waitedMs} ms of a ${budgetMs} ms budget (${cls.priority} budget is ${WAIT_BUDGET_MS[cls.priority]} ms, weighted by Jev's probabilities). Retry after ${Math.ceil(admission.retryAfterMs / 1000)} s.`,
        );
      if (cls.priority === "critical" && admission.kind === "reject" && admission.reason === "pool-empty")
        out.push(
          "Because a critical request could not be admitted, the yield flag was raised: batch jobs will pause at their next chunk boundary.",
        );
      break;
    case "probe":
      out.push("Admitted as the single half-open probe: the breaker's cooldown elapsed and this request tests whether upstream recovered.");
      break;
    case "admit":
      out.push(
        `Admitted at tier ${state.tier} ${TIER_NAMES[state.tier]} with a token from the ${admission.from} pool${admission.from !== cls.priority ? " (borrowed)" : ""}${waitedMs > 0 ? ` after waiting ${waitedMs} ms` : ""}.`,
      );
      if (admission.hedge.allowed)
        out.push(
          `Hedge armed: a second copy would be sent if the first had not returned within ${admission.hedge.delayMs} ms (1.5× the rolling p50), first response wins, loser aborted.`,
        );
      else if (admission.hedge.gate && admission.hedge.gate !== "off")
        out.push(`No hedge: the ${admission.hedge.gate} gate failed (${hedgeGateText(admission.hedge.gate)}).`);
      break;
  }
  return out;
}

function hedgeGateText(gate: string): string {
  switch (gate) {
    case "class":
      return "only critical requests hedge";
    case "tier":
      return "hedging is off at HARD_THROTTLE and above so it cannot amplify a slowdown";
    case "pool":
      return "the critical pool needs at least 2 tokens, one per copy";
    case "idempotency":
      return "no Idempotency-Key was sent, so a duplicate could double-apply";
    case "safeToRetry":
      return "Jev vetoed: it judged this request unsafe to run twice";
    default:
      return gate;
  }
}

export function explainUpstream(
  result: UpstreamResult,
  elapsedMs: number,
  params: UpstreamParams,
  hedgeHeader: string,
  probe: boolean,
): string[] {
  const out: string[] = [];
  if (result.timeout)
    out.push(`Upstream timed out after ${elapsedMs} ms (hard limit 2 s), returned as 504. Timeouts count toward the escalation rule.`);
  else if (!result.ok)
    out.push(
      `Upstream itself failed after ${elapsedMs} ms, returned as 502. The simulated upstream fails ${Math.round(params.fail * 100)}% of calls right now; the guard admitted the request correctly and recorded the failure, which counts toward the error-rate rule.`,
    );
  else
    out.push(
      `Upstream succeeded in ${elapsedMs} ms (simulated latency ${params.latency} ms${params.tail > 0 ? `, ${Math.round(params.tail * 100)}% of calls 5× slower` : ""}).`,
    );
  if (hedgeHeader.startsWith("fired"))
    out.push(
      `The hedge fired: the first copy exceeded the delay, a second copy was sent, and copy ${hedgeHeader.endsWith("2") ? "2" : "1"} answered first; the other was aborted.`,
    );
  if (probe)
    out.push(
      result.ok
        ? "The probe succeeded: breaker CLOSED, tier set to 3 SHED, recovery walks down from here."
        : "The probe failed: breaker OPEN again with a doubled cooldown.",
    );
  return out;
}
