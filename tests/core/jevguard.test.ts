import { describe, expect, it } from "vitest";
import { initialState, jevGate, noteJevCall, noteJevError, noteJevSuccess } from "../../src/core";

describe("Jev budget guard and inner breaker", () => {
  const now = 20_000_000;
  it("allows by default and bypasses when off", () => {
    const j = initialState(now).jev;
    expect(jevGate(j, now).ok).toBe(true);
    expect(jevGate({ ...j, off: true }, now).tag).toBe("deterministic");
  });

  it("stops at 60 calls per minute and resets on the next minute", () => {
    let j = initialState(now).jev;
    for (let i = 0; i < 60; i++) j = noteJevCall(j, now);
    expect(jevGate(j, now).tag).toBe("jev-bypassed-budget");
    expect(jevGate(j, now + 60_000).ok).toBe(true);
  });

  it("opens the inner breaker after three consecutive errors for 30 s", () => {
    let j = initialState(now).jev;
    j = noteJevError(j, now);
    j = noteJevError(j, now);
    expect(jevGate(j, now).ok).toBe(true);
    j = noteJevError(j, now);
    expect(jevGate(j, now + 1).tag).toBe("jev-error");
    expect(jevGate(j, now + 30_001).ok).toBe(true);
    expect(jevGate(noteJevSuccess(j), now + 1).ok).toBe(true);
  });
});
