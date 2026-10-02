import { describe, expect, it, vi, afterEach } from "vitest";
import { JevBudget } from "@/server/jev-budget";
import { screenPost } from "@/server/jev";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("Jev budget", () => {
  it("reserves before dispatch and keeps unknown calls charged", () => {
    const ledger = new JevBudget(":memory:", 0.003);
    const id = ledger.reserve()!;
    expect(id).toBeTruthy();
    expect(ledger.reserve()).toBeNull();
    expect(ledger.settle(id, "unexpected-model", 10)).toBe(false);
    expect(ledger.summary().unknownRequests).toBe(1);
    expect(ledger.settle(id, "jev-1.13.0", 100)).toBe(true);
    expect(ledger.settle(id, "jev-1.13.0", 100)).toBe(false);
    expect(ledger.reserve()).toBeTruthy();
    expect(ledger.summary().chargedOrReservedUsd).toBeLessThanOrEqual(0.003);
    ledger.close();
  });
  it("rejects excessive or unset budget configuration", () => {
    expect(() => new JevBudget(":memory:", 11)).toThrow();
    expect(() => new JevBudget(":memory:", NaN)).toThrow();
  });
  it("does not send or truncate oversized public content", async () => {
    vi.stubEnv("JEV_MOCK", "");
    const fetching = vi.spyOn(globalThis, "fetch");
    const result = await screenPost("가".repeat(10_000));
    expect(result.status).toBe("held");
    expect(fetching).not.toHaveBeenCalled();
  });
});
