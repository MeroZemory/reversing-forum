import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { JevBudget } from "@/server/jev-budget";
import {
  buildRelevant,
  classify,
  prepareRequests,
  TriageRunner,
  type Packet,
  type Message,
} from "../../scripts/chat-jev-triage";

const folders: string[] = [],
  ledgers: JevBudget[] = [];
const directory = () => {
  const p = mkdtempSync(resolve(tmpdir(), "synthetic-triage-"));
  folders.push(p);
  return p;
};
const budget = (limit = 10, path = ":memory:") => {
  const b = new JevBudget(path, limit);
  ledgers.push(b);
  return b;
};
afterEach(() => {
  ledgers.splice(0).forEach((b) => b.close());
  folders.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
const packet = (count = 80): Packet => ({
  packetId: "synthetic",
  instructions: "synthetic",
  blocks: [
    {
      batchId: "block",
      inputHash: "synthetic-hash",
      messages: Array.from({ length: count }, (_, i): Message => [
        i,
        "synthetic-speaker",
        `synthetic disassembly question ${i}`,
        [],
      ]),
    },
  ],
});
const answer = (
  choice = "candidate",
  confidence = 0.99,
  probability = 0.99,
) => ({
  type: "choice",
  choice,
  confidence,
  probabilities: Object.fromEntries(
    ["candidate", "ordinary", "uncertain"].map((k) => [
      k,
      k === choice ? probability : (1 - probability) / 2,
    ]),
  ),
});
const payload = (body: string, choose = (_id: string) => answer()) => ({
  model: "jev-1.13.0",
  usage: { input_tokens: 100 },
  answers: Object.fromEntries(
    Object.keys(JSON.parse(body).questions).map((id) => [id, choose(id)]),
  ),
});
const fetcher = (choose?: (id: string) => ReturnType<typeof answer>) =>
  vi.fn<typeof fetch>(
    async (_url, init) =>
      new Response(JSON.stringify(payload(init!.body as string, choose)), {
        status: 200,
      }),
  );

describe("private Jev coarse triage (synthetic only)", () => {
  it("covers every nonnull nonheld input index once and bounds UTF8 state including overlap", () => {
    const p = packet(103);
    p.blocks[0].messages[4] = null;
    p.blocks[0].messages[7]![3] = ["held"];
    p.blocks[0].messages[7]![2] = "DO NOT TRANSMIT";
    p.blocks[0].messages[8]![2] = null;
    const prepared = prepareRequests(p),
      covered: number[] = [];
    for (const w of prepared.windows)
      for (let i = w.start; i <= w.end; i++) {
        const m = p.blocks[0].messages[i];
        if (m && m[2] !== null && !m[3].includes("held")) covered.push(i);
      }
    expect(new Set(covered).size).toBe(covered.length);
    expect(covered.length).toBe(100);
    expect(prepared.windows[1]).toMatchObject({
      start: 25,
      end: 49,
      contextStart: 20,
      contextEnd: 54,
    });
    for (const req of prepared.requests) {
      const body = JSON.parse(req.body);
      expect(Buffer.byteLength(body.state)).toBeLessThanOrEqual(20_000);
      expect(req.body).not.toContain("DO NOT TRANSMIT");
      expect(Object.keys(body.questions).length).toBeGreaterThan(1);
    }
  });
  it("downgrades weak ordinary and propagates uncertain without removing original evidence or context", async () => {
    const p = packet(80),
      f = fetcher((id) =>
        id.includes("_0_")
          ? answer("ordinary")
          : id.includes("_25_")
            ? answer("ordinary", 0.979)
            : id.includes("_50_")
              ? answer("candidate")
              : answer("uncertain"),
      );
    const r = await new TriageRunner({
      budget: budget(),
      key: "synthetic",
      cacheDirectory: directory(),
      fetcher: f,
    }).triage(p);
    expect(r.complete).toBe(true);
    expect(r.windows.map((w) => w.label)).toEqual([
      "ordinary",
      "uncertain",
      "candidate",
      "uncertain",
    ]);
    const built = buildRelevant(p, r);
    expect(built.packet.blocks[0].messages.map((m) => m![0])).toEqual(
      Array.from({ length: 60 }, (_, i) => i + 20),
    );
    expect(built.mapping[0].noncandidateRanges).toEqual([
      { start: 0, end: 19, source: "jev", lunaExamined: false },
    ]);
    expect(built.packet.packetId).toBe(p.packetId);
    expect(built.lunaExaminedEntirePacket).toBe(false);
    const duplicate = {
      ...r,
      windows: [r.windows[0], r.windows[0], ...r.windows.slice(2)],
    };
    expect(() => buildRelevant(p, duplicate)).toThrow("triage-scope-mismatch");
  });
  it("requires exact answer ids, types and normalized probabilities; malformed scope is wholly uncertain", () => {
    const { requests } = prepareRequests(packet());
    const req = requests[0],
      good = payload(req.body);
    for (const modify of [
      (x: typeof good) => {
        delete x.answers[req.windows[0].id];
      },
      (x: typeof good) => {
        x.answers.extra = answer();
      },
      (x: typeof good) => {
        x.answers[req.windows[0].id].type = "boolean";
      },
      (x: typeof good) => {
        x.answers[req.windows[0].id].confidence = NaN;
      },
      (x: typeof good) => {
        x.answers[req.windows[0].id].probabilities.ordinary = 1;
      },
    ]) {
      const copy = structuredClone(good);
      modify(copy);
      const result = classify(copy, req.windows);
      expect(result.complete).toBe(false);
      expect(result.windows.every((w) => w.label === "uncertain")).toBe(true);
    }
  });
  it("never sends oversized windows and retains all their content for native reading", async () => {
    const p = packet(25);
    p.blocks[0].messages[0]![2] = "x".repeat(21_000);
    const f = fetcher();
    const r = await new TriageRunner({
      budget: budget(),
      key: "synthetic",
      cacheDirectory: directory(),
      fetcher: f,
    }).triage(p);
    expect(f).not.toHaveBeenCalled();
    expect(r.complete).toBe(false);
    expect(r.windows[0].cause).toBe("oversized-window");
    expect(buildRelevant(p, r).packet.blocks[0].messages.length).toBe(25);
  });
  it("reserves before HTTP, settles known usage, replays persistent cache without another charge, and deduplicates concurrent requests", async () => {
    const b = budget(),
      dir = directory(),
      f = fetcher();
    const wrapped = vi.fn<typeof fetch>(async (url, init) => {
      expect(b.summary().unknownRequests).toBe(1);
      return f(url, init);
    });
    const runner = new TriageRunner({
      budget: b,
      key: "synthetic",
      cacheDirectory: dir,
      fetcher: wrapped,
    });
    const [a, c] = await Promise.all([
      runner.triage(packet()),
      runner.triage(packet()),
    ]);
    expect(a).toEqual(c);
    expect(f).toHaveBeenCalledTimes(1);
    expect(b.summary().unknownRequests).toBe(0);
    expect(b.summary().chargedOrReservedUsd).toBeCloseTo(0.0000042);
    const replay = await new TriageRunner({
      budget: b,
      key: "synthetic",
      cacheDirectory: dir,
      fetcher: f,
    }).triage(packet());
    expect(replay).toEqual(a);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("keeps unknown usage reserved, retries API errors only twice with bounded backoff, and caches partial results", async () => {
    const b = budget(),
      dir = directory(),
      f = vi.fn<typeof fetch>(async () => {
        throw new Error("synthetic failure");
      }),
      sleep = vi.fn(async () => {});
    const r = await new TriageRunner({
      budget: b,
      key: "synthetic",
      cacheDirectory: dir,
      fetcher: f,
      sleep,
    }).triage(packet());
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
    expect(b.summary().unknownRequests).toBe(3);
    expect(r.complete).toBe(false);
    expect(r.windows.every((w) => w.label === "uncertain")).toBe(true);
    await new TriageRunner({
      budget: b,
      key: "synthetic",
      cacheDirectory: dir,
      fetcher: f,
    }).triage(packet());
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("does not retry invalid classification or unknown usage and blocks dispatch when budget is exhausted", async () => {
    for (const response of [
      { model: "jev-1.13.0", usage: { input_tokens: 100 }, answers: {} },
      { answers: {} },
    ]) {
      const f = vi.fn<typeof fetch>(
        async () => new Response(JSON.stringify(response)),
      );
      const r = await new TriageRunner({
        budget: budget(),
        key: "synthetic",
        cacheDirectory: directory(),
        fetcher: f,
      }).triage(packet());
      expect(f).toHaveBeenCalledTimes(1);
      expect(r.complete).toBe(false);
    }
    const b = budget(0.002),
      f = fetcher();
    const r = await new TriageRunner({
      budget: b,
      key: "synthetic",
      cacheDirectory: directory(),
      fetcher: f,
    }).triage(packet());
    expect(f).not.toHaveBeenCalled();
    expect(r.windows[0].cause).toBe("budget-exhausted");
  });
  it("pending durable claims cannot redispatch, even in another runner", async () => {
    const dir = directory(),
      req = prepareRequests(packet()).requests[0],
      f = fetcher(),
      b = budget();
    writeFileSync(
      resolve(dir, `${req.hash}.json`),
      JSON.stringify({ state: "pending" }),
    );
    const r = await new TriageRunner({
      budget: b,
      key: "synthetic",
      cacheDirectory: dir,
      fetcher: f,
    }).triage(packet());
    expect(f).not.toHaveBeenCalled();
    expect(r.complete).toBe(false);
    expect(b.summary().requests).toBe(0);
    expect(
      JSON.parse(readFileSync(resolve(dir, `${req.hash}.json`), "utf8")).state,
    ).toBe("pending");
  });
  it("separate SQLite handles atomically share maximum reservations and the call cap includes prior calls", async () => {
    const dir = directory(),
      a = budget(0.003, resolve(dir, "synthetic.sqlite")),
      b = budget(0.003, resolve(dir, "synthetic.sqlite"));
    expect(a.reserve()).toBeTruthy();
    expect(b.reserve()).toBeNull();
    const f = fetcher();
    const r = await new TriageRunner({
      budget: b,
      key: "synthetic",
      cacheDirectory: resolve(dir, "cache"),
      fetcher: f,
      callCap: 1,
    }).triage(packet());
    expect(f).not.toHaveBeenCalled();
    expect(r.windows[0].cause).toBe("call-cap");
  });
});
