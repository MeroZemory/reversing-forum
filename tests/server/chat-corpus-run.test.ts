import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { stopCodexProcess } from "../../src/server/chat-pipeline/relative-context";
import { qualityPolicyVersion } from "../../src/server/chat-pipeline/editorial-policy";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  nodeRunner,
  createNodeRunner,
  parseOptions,
  validate,
  runCorpus,
  type Launch,
  type Runner,
} from "../../scripts/chat-corpus-run";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const id = (n: number) => n.toString(16).padStart(64, "0");
const write = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
function fixture(count = 3) {
  const root = mkdtempSync(join(tmpdir(), "corpus-run-"));
  roots.push(root);
  const directory = join(root, "data/chat-pipeline");
  for (const mode of ["candidate", "draft", "draft-purpose", "review"]) {
    write(
      join(root, "src/server/chat-pipeline/schemas", `${mode}.schema.json`),
      read(resolve("src/server/chat-pipeline/schemas", `${mode}.schema.json`)),
    );
    write(
      join(directory, "schemas", `${mode}.schema.json`),
      read(resolve("src/server/chat-pipeline/schemas", `${mode}.schema.json`)),
    );
  }
  const packets = Array.from({ length: count }, (_, n) => ({
    packetId: id(n + 1),
    file: join(directory, "triage/relevant", `${id(n + 1)}.input.json`),
  }));
  write(join(directory, "triage/relevant/manifest.json"), { packets });
  for (const packet of packets)
    write(packet.file, {
      packetId: packet.packetId,
      blocks: [
        {
          batchId: packet.packetId,
          messages: [[0, "synthetic", "private synthetic evidence", []]],
        },
      ],
    });
  return { root, directory, packets };
}
const command = (launch: Launch) => {
  const index = launch.args.findIndex((arg) => arg.endsWith(".ts"));
  return {
    script: basename(launch.args[index]),
    args: launch.args.slice(index + 1),
  };
};
const candidateOutput = (packetId: string) => ({
  packetId,
  complete: true,
  blocks: [
    {
      batchId: packetId,
      candidates: [],
      noncandidateRanges: [[0, 0]],
      contextIds: [],
    },
  ],
});

it("rejects a stale quality-policy enum before a cached output can be reused", () => {
  const schema = { type: "string", enum: ["reusable-technical-knowledge-v3"] };
  expect(() =>
    validate("reusable-technical-knowledge-v3", schema),
  ).not.toThrow();
  expect(() => validate("self-contained-technical-v1", schema)).toThrow(
    "invalid-existing-output",
  );
  expect(() => validate("anything", { type: "string", enum: [] })).toThrow(
    "unsupported-output-schema",
  );
});

it.each([
  { purpose: false, cached: true, kind: undefined, valid: true },
  { purpose: true, cached: true, kind: "question", valid: true },
  { purpose: true, cached: true, kind: "share", valid: true },
  { purpose: true, cached: false, kind: "question", valid: true },
  { purpose: true, cached: false, kind: "share", valid: true },
  { purpose: true, cached: true, kind: undefined, valid: false },
  { purpose: true, cached: false, kind: undefined, valid: false },
  { purpose: true, cached: true, kind: "other", valid: false },
])(
  "routes draft contract and reuses cache unchanged: %j",
  async ({ purpose, cached, kind, valid }) => {
    const { root, directory } = fixture(1);
    const input = join(
      directory,
      "editorial-batches",
      `${id(1)}.draft.input.json`,
    );
    const output = input.replace(".input.json", ".output.json");
    const reviewInput = input.replace(".draft.", ".review.");
    const reviewOutput = reviewInput.replace(".input.json", ".output.json");
    const bundle = input.replace(".draft.input.json", ".bundle.json");
    const approved = input.replace(".draft.input.json", ".approved.json");
    write(input, {
      ...(purpose ? { draftSchema: "draft-purpose" } : {}),
      entries: [{ candidateKey: id(4) }],
    });
    const draft = {
      complete: true,
      entries: [
        {
          candidateKey: id(4),
          title: "Synthetic",
          body: "Synthetic",
          ...(kind === undefined ? {} : { kind }),
          tags: [],
          ready: true,
          quality: true,
          reasons: [],
        },
      ],
    };
    if (cached) write(output, draft);
    const original = cached ? readFileSync(output) : undefined;
    const calls: Launch[] = [];
    const runner: Runner = async (launch) => {
      calls.push(launch);
      const { script, args } = command(launch);
      if (script === "chat-codex-run.ts") {
        expect(args[0]).toBe("draft");
        expect(basename(args[3])).toBe(
          purpose ? "draft-purpose.schema.json" : "draft.schema.json",
        );
        write(args[2], draft);
      } else if (script === "chat-editorial-batches.ts") {
        if (args[0] === "prepare") {
          write(join(directory, "editorial-batches/manifest.json"), {
            packets: [{ packetId: id(1), input, output }],
          });
        } else if (args[0] === "review") {
          write(reviewInput, { entries: [], draftHeld: [] });
          return {
            code: 0,
            stdout: JSON.stringify({ reviewInput, reviewOutput }),
          };
        } else if (args[0] === "bundle") {
          write(bundle, { entries: [] });
          write(approved, { entries: [] });
          return {
            code: 0,
            stdout: JSON.stringify({ bundle, review: approved, held: 0 }),
          };
        }
      } else throw new Error("unexpected helper");
      return { code: 0 };
    };
    const options = { root, phase: "draft" as const, concurrency: 1 };
    const first = await runCorpus(options, runner);
    expect(first.code).toBe(valid ? 0 : 1);
    expect(
      calls.filter((c) => command(c).script === "chat-codex-run.ts"),
    ).toHaveLength(cached ? 0 : 1);
    if (original) expect(readFileSync(output)).toEqual(original);
    if (!valid) {
      expect(first.progress.failures?.at(-1)?.errorCode).toBe(
        "invalid-existing-output",
      );
      expect(calls.some((c) => command(c).args[0] === "review")).toBe(false);
      return;
    }
    const steps = structuredClone(first.progress.steps);
    const bytes = readFileSync(output);
    calls.length = 0;
    const resumed = await runCorpus(options, runner);
    expect(resumed.code).toBe(0);
    expect(resumed.progress.steps).toEqual(steps);
    expect(readFileSync(output)).toEqual(bytes);
    expect(calls.some((c) => command(c).script === "chat-codex-run.ts")).toBe(
      false,
    );
  },
);

describe("optional candidate shard routing", () => {
  it("parses 1..6 blocks and rejects invalid values without changing defaults", () => {
    expect(parseOptions(["candidate"]).candidateShardBlocks).toBeUndefined();
    for (const n of [1, 2, 6])
      expect(
        parseOptions(["all", "--candidate-shard-blocks", String(n)])
          .candidateShardBlocks,
      ).toBe(n);
    for (const n of ["0", "7", "1.5", "NaN", ""])
      expect(() =>
        parseOptions(["candidate", "--candidate-shard-blocks", n]),
      ).toThrow("invalid-candidate-shard-limit");
  });

  it("runs real candidate command per child and imports only the combined original packet", async () => {
    const { root, packets } = fixture(1);
    const source = read(packets[0].file);
    source.instructions = ["Synthetic instructions"];
    source.blocks = Array.from({ length: 5 }, (_, n) => ({
      ...source.blocks[0],
      batchId: id(n + 10),
    }));
    write(packets[0].file, source);
    const calls: Launch[] = [];
    const runner: Runner = async (launch) => {
      calls.push(launch);
      const { script, args } = command(launch);
      if (script === "chat-codex-run.ts") {
        const child = read(args[1]);
        write(args[2], {
          packetId: child.packetId,
          complete: true,
          blocks: child.blocks.map((b: any) => ({
            ...candidateOutput(child.packetId).blocks[0],
            batchId: b.batchId,
          })),
        });
      }
      return { code: 0 };
    };
    const result = await runCorpus(
      { root, phase: "candidate", concurrency: 2, candidateShardBlocks: 2 },
      runner,
    );
    expect(result.code).toBe(0);
    const models = calls
      .map(command)
      .filter((c) => c.script === "chat-codex-run.ts");
    expect(models.map((c) => read(c.args[1]).blocks.length)).toEqual([2, 2, 1]);
    const imports = calls
      .map(command)
      .filter((c) => c.script === "chat-native-batches.ts");
    expect(imports).toHaveLength(1);
    expect(read(imports[0].args[1]).blocks.map((b: any) => b.batchId)).toEqual(
      source.blocks.map((b: any) => b.batchId),
    );
  });

  it.each([
    "malformed",
    "account-unavailable-or-changed",
    "batch-proxy-budget-boundary",
  ])(
    "stops %s without import or quarantine even when quarantine is requested",
    async (failure) => {
      const { root } = fixture(1);
      const calls: Launch[] = [];
      const result = await runCorpus(
        {
          root,
          phase: "candidate",
          concurrency: 1,
          candidateShardBlocks: 2,
          quarantineInvalidCandidates: true,
        },
        async (launch) => {
          calls.push(launch);
          const { args } = command(launch);
          if (failure === "malformed") {
            write(args[2], { complete: true });
            return { code: 0 };
          }
          return { code: 1, errorCode: failure };
        },
      );
      expect(result.code).toBe(1);
      expect(
        calls.map(command).every((c) => c.script === "chat-codex-run.ts"),
      ).toBe(true);
      expect(
        result.progress.failures?.some(
          (f) =>
            f.errorCode ===
            (failure === "malformed"
              ? "candidate-shard-output-invalid"
              : failure),
        ),
      ).toBe(true);
    },
  );
});
function candidateRunner(calls: Launch[]): Runner {
  return async (launch) => {
    calls.push(launch);
    const { script, args } = command(launch);
    if (script === "chat-codex-run.ts")
      write(args[2], candidateOutput(read(args[1]).packetId));
    if (script === "chat-native-batches.ts" && args[0] === "repair-relevant")
      return {
        code: 0,
        stdout: JSON.stringify({
          repaired: true,
          repairCounts: { needsContextMessages: 3, needsContextCandidates: 1 },
        }),
      };
    return { code: 0 };
  };
}
const contextOnlyReceipt = () => ({
  quarantined: true,
  modelResultAccepted: false,
  fullMeaningComplete: false,
  source: "deterministic-quarantine",
  importedBatches: 1,
  importedCandidates: 0,
  contextCounts: {
    candidates: 0,
    noncandidate: 0,
    needsContextCandidates: 0,
    needsContextMessages: 1,
  },
});

describe("corpus orchestration boundaries", () => {
  it.each([
    { enabled: false, fresh: false, transportFailed: false, native: false },
    { enabled: true, fresh: false, transportFailed: false, native: false },
    { enabled: true, fresh: true, transportFailed: false, native: false },
    { enabled: true, fresh: true, transportFailed: true, native: false },
    { enabled: true, fresh: false, transportFailed: false, native: true },
  ])(
    "complete:false prefix is quarantined only after successful relevant transport with opt-in: %j",
    async ({ enabled, fresh, transportFailed, native }) => {
      const { root, directory, packets } = fixture(1);
      const packet = packets[0];
      const source = read(packet.file);
      source.blocks.push({
        batchId: id(99),
        messages: [[0, "synthetic", "private synthetic context", []]],
      });
      write(packet.file, source);
      const prefix = {
        ...candidateOutput(packet.packetId),
        complete: false,
        blocks: [
          {
            batchId: packet.packetId,
            candidates: [
              {
                localId: "c1",
                title: "합성 분석 질문",
                topic: "분석",
                questionIds: [0],
                responseIds: [],
                uncertainties: [],
                needsContext: false,
              },
            ],
            noncandidateRanges: [],
            contextIds: [],
          },
        ],
      };
      const output = native
        ? join(directory, "native", `${packet.packetId}.output.json`)
        : packet.file.replace(".input.json", ".output.json");
      if (native) write(output.replace(".output.json", ".input.json"), source);
      if (!fresh) write(output, prefix);
      const calls: Launch[] = [];
      const runner: Runner = async (launch) => {
        calls.push(launch);
        const { script, args } = command(launch);
        if (script === "chat-codex-run.ts") {
          write(args[2], prefix);
          return {
            code: transportFailed ? 1 : 0,
            errorCode: transportFailed ? "incomplete-output" : undefined,
          };
        }
        expect(script).toBe("chat-native-batches.ts");
        expect(args).toEqual(["context-only", output]);
        const receipt = contextOnlyReceipt();
        receipt.importedBatches = 2;
        receipt.contextCounts.needsContextMessages = 2;
        return { code: 0, stdout: JSON.stringify(receipt) };
      };
      const options = {
        root,
        phase: "candidate" as const,
        concurrency: 1,
        repairRelevant: true,
        quarantineInvalidCandidates: enabled,
      };
      const result = await runCorpus(options, runner);
      const recovered = enabled && !transportFailed && !native;
      expect(result.code).toBe(recovered ? 0 : 1);
      expect(readFileSync(output, "utf8")).toBe(JSON.stringify(prefix));
      expect(
        calls.filter((c) => command(c).script === "chat-codex-run.ts"),
      ).toHaveLength(fresh ? 1 : 0);
      expect(
        calls.filter((c) => command(c).args[0] === "context-only"),
      ).toHaveLength(recovered ? 1 : 0);
      expect(result.progress.counts.imported).toBe(recovered ? 2 : 0);
      expect(result.progress.failures?.at(-1)?.errorCode).toBe(
        "incomplete-output",
      );
      if (recovered) {
        expect(
          result.progress.steps[`import:${packet.packetId}`],
        ).toMatchObject({
          count: 2,
          quarantined: true,
          needsContext: 2,
          needsContextCandidates: 0,
        });
        calls.length = 0;
        expect((await runCorpus(options, runner)).code).toBe(0);
        expect(calls).toHaveLength(0);
      }
    },
  );

  it.each(["native", "schema"])(
    "bulk quarantine continues and resumes with an immutable rejected %s output and separate checkpoint",
    async (origin) => {
      const { root, directory, packets } = fixture();
      for (const p of packets)
        write(
          p.file.replace(".input.json", ".output.json"),
          candidateOutput(p.packetId),
        );
      const rejected = packets[0].file.replace(".input.json", ".output.json");
      const bad = candidateOutput(packets[0].packetId);
      if (origin === "native") bad.blocks[0].noncandidateRanges = [[0, 999]];
      write(rejected, origin === "schema" ? { ...bad, extra: true } : bad);
      const before = readFileSync(rejected, "utf8");
      const calls: Launch[] = [];
      const runner: Runner = async (launch) => {
        calls.push(launch);
        const { script, args } = command(launch);
        expect(script).toBe("chat-native-batches.ts");
        if (args[0] === "context-only")
          return { code: 0, stdout: JSON.stringify(contextOnlyReceipt()) };
        if (args[1] === rejected)
          return {
            code: 1,
            errorCode: "invalid-native-range",
            stdout: "private diagnostic test@example.com",
          };
        return { code: 0 };
      };
      const options = {
        root,
        phase: "candidate" as const,
        concurrency: 4,
        quarantineInvalidCandidates: true,
        separateCandidateProgress: true,
      };
      const result = await runCorpus(options, runner);
      expect(result.code).toBe(0);
      expect(result.progress.counts).toMatchObject({
        imported: 3,
        quarantinedPackets: 1,
        needsContext: 1,
        needsContextCandidates: 0,
      });
      expect(
        result.progress.steps[`import:${packets[0].packetId}`],
      ).toMatchObject({ quarantined: true, needsContext: 1 });
      expect(
        calls.filter((c) => command(c).args[0] === "context-only"),
      ).toHaveLength(1);
      expect(calls.every((c) => !c.signal.aborted)).toBe(true);
      expect(readFileSync(rejected, "utf8")).toBe(before);
      expect(result.progress.failures?.at(-1)?.errorCode).toBe(
        origin === "native"
          ? "invalid-native-range"
          : "invalid-existing-output",
      );
      const checkpoint = readFileSync(
        join(directory, "candidate-progress.json"),
        "utf8",
      );
      expect(checkpoint).not.toContain("test@example.com");
      expect(checkpoint).not.toContain("private diagnostic");
      calls.length = 0;
      expect((await runCorpus(options, runner)).code).toBe(0);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    {
      enabled: false,
      native: false,
      script: "chat-native-batches.ts",
      exit: 1,
      error: "invalid-native-range",
    },
    {
      enabled: true,
      native: true,
      script: "chat-native-batches.ts",
      exit: 1,
      error: "out-of-scope-native-evidence",
    },
    {
      enabled: true,
      native: false,
      script: "chat-native-batches.ts",
      exit: 2,
      error: "invalid-native-range",
    },
    {
      enabled: true,
      native: false,
      script: "chat-native-batches.ts",
      exit: 1,
      error: "conflicting-batch-output",
    },
    {
      enabled: true,
      native: false,
      script: "chat-native-batches.ts",
      exit: 1,
      error: "native-batch-input-mismatch",
    },
    {
      enabled: true,
      native: false,
      script: "chat-native-batches.ts",
      exit: 1,
      error: "relevant-manifest-mismatch",
    },
    {
      enabled: true,
      native: false,
      script: "chat-native-batches.ts",
      exit: 1,
      error: "native-initialization-failed",
    },
    {
      enabled: true,
      native: false,
      script: "chat-native-batches.ts",
      exit: 1,
      error: "native-database-busy",
    },
    {
      enabled: true,
      native: false,
      script: "chat-native-batches.ts",
      exit: 1,
      error: "native-format-failed",
    },
    {
      enabled: true,
      native: false,
      script: "chat-codex-run.ts",
      exit: 1,
      error: "network-failure",
    },
    {
      enabled: true,
      native: false,
      script: "chat-codex-run.ts",
      exit: 2,
      error: "account-unavailable-or-changed",
    },
    {
      enabled: true,
      native: false,
      script: "chat-codex-run.ts",
      exit: 1,
      error: "invalid-candidate-schema",
    },
  ])(
    "quarantine preserves stopping for noneligible/default/native failures: %j",
    async ({ enabled, native, script, exit, error }) => {
      const { root, directory, packets } = fixture();
      if (script !== "chat-codex-run.ts")
        write(
          packets[0].file.replace(".input.json", ".output.json"),
          candidateOutput(packets[0].packetId),
        );
      if (native) {
        write(
          join(directory, "native", `${packets[0].packetId}.input.json`),
          read(packets[0].file),
        );
        write(
          join(directory, "native", `${packets[0].packetId}.output.json`),
          candidateOutput(packets[0].packetId),
        );
      }
      const calls: Launch[] = [];
      const runner: Runner = async (launch) => {
        calls.push(launch);
        return { code: exit, errorCode: error };
      };
      const result = await runCorpus(
        {
          root,
          phase: "candidate",
          concurrency: 1,
          quarantineInvalidCandidates: enabled,
        },
        runner,
      );
      expect(result.code).toBe(exit === 2 ? 2 : 1);
      expect(calls).toHaveLength(1);
      expect(command(calls[0]).script).toBe(script);
      expect(command(calls[0]).args[0]).not.toBe("context-only");
      if (native) expect(command(calls[0]).args[0]).toBe("import");
      expect(result.progress.counts.imported).toBe(0);
      if (error === "native-database-busy")
        expect(result.progress.failures?.at(-1)?.errorCode).toBe(error);
    },
  );

  it("a context-only conflict or positive receipt still stops bulk processing", async () => {
    for (const conflict of [true, false]) {
      const { root, packets } = fixture();
      for (const p of packets)
        write(
          p.file.replace(".input.json", ".output.json"),
          candidateOutput(p.packetId),
        );
      const calls: Launch[] = [];
      const runner: Runner = async (launch) => {
        calls.push(launch);
        if (command(launch).args[0] === "context-only")
          return conflict
            ? { code: 1, errorCode: "conflicting-batch-output" }
            : {
                code: 0,
                stdout: JSON.stringify({
                  ...contextOnlyReceipt(),
                  modelResultAccepted: true,
                }),
              };
        return { code: 1, errorCode: "out-of-scope-native-evidence" };
      };
      const result = await runCorpus(
        {
          root,
          phase: "candidate",
          concurrency: 1,
          quarantineInvalidCandidates: true,
        },
        runner,
      );
      expect(result.code).toBe(1);
      expect(calls.map((c) => command(c).args[0])).toEqual([
        "import-relevant",
        "context-only",
      ]);
      expect(result.progress.counts.imported).toBe(0);
      expect(result.progress.failures?.at(-1)?.errorCode).toBe(
        conflict ? "conflicting-batch-output" : "invalid-quarantine-receipt",
      );
    }
  });

  it("outer abort invokes the same Windows PID-tree helper and awaits its completion without spawn signal", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const spawn = vi.fn(() => child);
    let completeStop!: () => void;
    const execute = vi.fn((_command, _args, _options, done) => {
      completeStop = () => done(null);
    });
    const stop = vi.fn((c) =>
      stopCodexProcess(
        c,
        "win32",
        execute as unknown as Parameters<typeof stopCodexProcess>[2],
      ),
    );
    const controller = new AbortController();
    const pending = createNodeRunner(
      spawn as unknown as Parameters<typeof createNodeRunner>[0],
      stop,
    )({
      executable: "synthetic",
      args: [],
      cwd: resolve("."),
      signal: controller.signal,
    });
    controller.abort();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4321", "/T", "/F"],
      { windowsHide: true },
      expect.any(Function),
    );
    expect(spawn.mock.calls[0]).toHaveLength(3);
    expect((spawn.mock.calls[0] as unknown[])[2]).not.toHaveProperty("signal");
    let finished = false;
    void pending.then(() => {
      finished = true;
    });
    child.emit("close", 0);
    await Promise.resolve();
    expect(finished).toBe(false);
    completeStop();
    expect(await pending).toMatchObject({
      code: 1,
      errorCode: "runner-aborted",
    });
    expect(child.kill).not.toHaveBeenCalled();
    controller.abort();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("outer abort never targets an unknown PID and safely reports a failed tree stop", async () => {
    for (const pid of [undefined, 0, -1, 1.5, 4321]) {
      const child = Object.assign(new EventEmitter(), {
        pid,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      }) as unknown as ChildProcess;
      const spawn = vi.fn(() => child);
      const stop = vi.fn(async () => {
        throw new Error("private process details");
      });
      const controller = new AbortController();
      const pending = createNodeRunner(
        spawn as unknown as Parameters<typeof createNodeRunner>[0],
        stop,
      )({
        executable: "synthetic",
        args: [],
        cwd: resolve("."),
        signal: controller.signal,
      });
      controller.abort();
      const result = await pending;
      expect(stop).toHaveBeenCalledTimes(pid === 4321 ? 1 : 0);
      expect(result).toMatchObject({
        code: 1,
        errorCode:
          pid === 4321 ? "codex-process-tree-stop-failed" : "runner-aborted",
      });
      expect(JSON.stringify(result)).not.toContain("private process details");
      expect(child.kill).not.toHaveBeenCalled();
    }
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn();
    const stop = vi.fn();
    expect(
      await createNodeRunner(
        spawn,
        stop,
      )({
        executable: "synthetic",
        args: [],
        cwd: resolve("."),
        signal: controller.signal,
      }),
    ).toMatchObject({ code: 1, errorCode: "runner-aborted" });
    expect(spawn).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("prepares schemas from tracked templates without private data from an earlier run", async () => {
    const { root, directory } = fixture(1);
    for (const mode of ["candidate", "draft", "review"])
      rmSync(join(directory, "schemas", `${mode}.schema.json`));
    const result = await runCorpus(
      { phase: "candidate", concurrency: 1, root },
      candidateRunner([]),
    );
    expect(result.code).toBe(0);
    expect(read(join(directory, "schemas/candidate.schema.json"))).toEqual(
      read(
        join(root, "src/server/chat-pipeline/schemas/candidate.schema.json"),
      ),
    );
  });
  it("launches Node with literal argv without shell expansion", async () => {
    const controller = new AbortController();
    const literal = "$(echo forbidden); & `echo forbidden`";
    const result = await nodeRunner({
      executable: process.execPath,
      args: [
        "--eval",
        "process.stdout.write(JSON.stringify(process.argv[1]))",
        literal,
      ],
      cwd: resolve("."),
      signal: controller.signal,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toBe(literal);
  });
  it("parses bounded concurrency, packet pilot and explicit publish-only env option", () => {
    expect(
      parseOptions(["candidate", "--separate-candidate-progress"])
        .separateCandidateProgress,
    ).toBe(true);
    expect(() =>
      parseOptions(["draft", "--separate-candidate-progress"]),
    ).toThrow("invalid-argument");
    expect(parseOptions(["all"])).toEqual({ phase: "all", concurrency: 2 });
    expect(
      parseOptions([
        "candidate",
        "--repair-relevant",
        "--quarantine-invalid-candidates",
        "--separate-candidate-progress",
      ]),
    ).toMatchObject({
      repairRelevant: true,
      quarantineInvalidCandidates: true,
      separateCandidateProgress: true,
    });
    expect(
      parseOptions([
        "publish",
        "--concurrency",
        "4",
        "--limit-packets",
        "2",
        "--publish-env-file",
      ]),
    ).toEqual({
      phase: "publish",
      concurrency: 4,
      limitPackets: 2,
      publishEnvFile: true,
    });
    for (const args of [
      ["all", "--concurrency", "5"],
      ["candidate", "--limit-packets", "0"],
      ["other"],
      ["all", "--concurrency", "NaN"],
    ])
      expect(() => parseOptions(args)).toThrow();
  });

  it.each([false, true])(
    "reuses the two native outputs strictly, generates later candidates then imports (repair=%s), and resumes",
    async (repairRelevant) => {
      const { root, directory, packets } = fixture();
      for (const packet of packets.slice(0, 2)) {
        write(
          join(directory, "native", `${packet.packetId}.input.json`),
          read(packet.file),
        );
        write(
          join(directory, "native", `${packet.packetId}.output.json`),
          candidateOutput(packet.packetId),
        );
      }
      const calls: Launch[] = [];
      const options = {
        root,
        phase: "candidate" as const,
        concurrency: 2,
        publishEnvFile: true,
        repairRelevant,
      };
      const result = await runCorpus(options, candidateRunner(calls));
      expect(result.code).toBe(0);
      expect(
        calls.filter((c) => command(c).script === "chat-codex-run.ts"),
      ).toHaveLength(1);
      expect(
        calls
          .filter((c) => command(c).script === "chat-native-batches.ts")
          .map((c) => command(c).args[0]),
      ).toEqual([
        "import",
        "import",
        repairRelevant ? "repair-relevant" : "import-relevant",
      ]);
      expect(
        calls.every(
          (c) =>
            c.executable === process.execPath &&
            !c.args.includes("--env-file=.env") &&
            !c.args.includes("-c"),
        ),
      ).toBe(true);
      const checkpoint = readFileSync(
        join(directory, "corpus-progress.json"),
        "utf8",
      );
      expect(checkpoint).not.toContain("private synthetic evidence");
      expect(checkpoint).not.toContain(root.replaceAll("\\", "\\\\"));
      calls.length = 0;
      expect((await runCorpus(options, candidateRunner(calls))).code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(result.progress.counts).toEqual({
        imported: 3,
        reviewed: 0,
        published: 0,
        held: 0,
        ...(repairRelevant
          ? { needsContext: 3, needsContextCandidates: 1 }
          : {}),
      });
    },
  );

  it("repair opt-in retains strict native checkpoint hashes while repairing a fresh relevant output", async () => {
    const { root, directory, packets } = fixture();
    for (const p of packets.slice(0, 2)) {
      write(
        join(directory, "native", `${p.packetId}.input.json`),
        read(p.file),
      );
      write(
        join(directory, "native", `${p.packetId}.output.json`),
        candidateOutput(p.packetId),
      );
    }
    const calls: Launch[] = [];
    const first = await runCorpus(
      { root, phase: "candidate", concurrency: 1, limitPackets: 2 },
      candidateRunner(calls),
    );
    const hashes = packets
      .slice(0, 2)
      .map((p) => first.progress.steps[`import:${p.packetId}`].hash);
    calls.length = 0;
    const second = await runCorpus(
      { root, phase: "candidate", concurrency: 1, repairRelevant: true },
      candidateRunner(calls),
    );
    expect(second.code).toBe(0);
    expect(
      packets
        .slice(0, 2)
        .map((p) => second.progress.steps[`import:${p.packetId}`].hash),
    ).toEqual(hashes);
    expect(calls.map((c) => [command(c).script, command(c).args[0]])).toEqual([
      ["chat-codex-run.ts", "candidate"],
      ["chat-native-batches.ts", "repair-relevant"],
    ]);
    calls.length = 0;
    expect(
      (
        await runCorpus(
          { root, phase: "candidate", concurrency: 1, repairRelevant: true },
          candidateRunner(calls),
        )
      ).code,
    ).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("extracts only known failure codes from child stderr without returning raw diagnostics", async () => {
    const controller = new AbortController();
    const result = await nodeRunner({
      executable: process.execPath,
      args: [
        "--eval",
        "process.stderr.write('test@example.com api_key=synthetic-secret (conflicting-message-disposition)'); process.exitCode=7",
      ],
      cwd: resolve("."),
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      code: 7,
      errorCode: "conflicting-message-disposition",
    });
    expect(JSON.stringify(result)).not.toContain("test@example.com");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(result).not.toHaveProperty("stderr");
  });

  it.each([
    "unknown-private-code",
    "test@example.com",
    "api_key=synthetic-secret",
  ])(
    "records safe failure metadata and resumes without persisting %s",
    async (untrusted) => {
      const { root, directory } = fixture(1);
      const failed = await runCorpus(
        { root, phase: "candidate", concurrency: 1 },
        async () => ({ code: 7, errorCode: untrusted, stdout: untrusted }),
      );
      expect(failed.code).toBe(1);
      expect(failed.progress.failures).toEqual([
        { script: "chat-codex-run.ts", exitCode: 7 },
      ]);
      const persisted = readFileSync(
        join(directory, "corpus-progress.json"),
        "utf8",
      );
      expect(persisted).not.toContain(untrusted);
      const calls: Launch[] = [];
      const resumed = await runCorpus(
        { root, phase: "candidate", concurrency: 1 },
        candidateRunner(calls),
      );
      expect(resumed.code).toBe(0);
      expect(resumed.progress.failures).toEqual(failed.progress.failures);
      expect(resumed.progress.counts.imported).toBe(1);
    },
  );

  it("records budget and thrown-runner failures with only known labels", async () => {
    const { root } = fixture(1);
    const budget = await runCorpus(
      { root, phase: "candidate", concurrency: 1 },
      async () => ({
        code: 2,
        stdout: JSON.stringify({
          reason: "batch-proxy-budget-boundary",
          privateText: "private synthetic evidence",
        }),
      }),
    );
    expect(budget.progress.failures).toEqual([
      {
        script: "chat-codex-run.ts",
        exitCode: 2,
        errorCode: "batch-proxy-budget-boundary",
      },
    ]);
    const thrown = await runCorpus(
      { root, phase: "candidate", concurrency: 1 },
      async () => {
        throw new Error("private synthetic evidence");
      },
    );
    expect(thrown.progress.failures?.at(-1)).toEqual({
      script: "chat-codex-run.ts",
      exitCode: 1,
      errorCode: "runner-failed",
    });
    expect(JSON.stringify(thrown.progress)).not.toContain(
      "private synthetic evidence",
    );
  });

  it("stops at budget exit 2, cancels active children and never schedules later packets", async () => {
    const { root } = fixture(6);
    const calls: Launch[] = [];
    const runner: Runner = async (launch) => {
      calls.push(launch);
      if (calls.length === 1) {
        await new Promise((done) => setTimeout(done, 5));
        return { code: 2 };
      }
      await new Promise((done) =>
        launch.signal.addEventListener("abort", done, { once: true }),
      );
      return { code: 1 };
    };
    const result = await runCorpus(
      { root, phase: "candidate", concurrency: 2 },
      runner,
    );
    expect(result.code).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.signal.aborted)).toBe(true);
    expect(result.progress.counts.imported).toBe(0);
  });

  it("preserves partial output and stops at the first ordinary failure", async () => {
    const { root, packets } = fixture();
    const calls: Launch[] = [];
    const runner: Runner = async (launch) => {
      calls.push(launch);
      write(command(launch).args[2], { complete: false });
      return { code: 1, stdout: "private child diagnostics" };
    };
    const result = await runCorpus(
      { root, phase: "candidate", concurrency: 1 },
      runner,
    );
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(1);
    calls.length = 0;
    expect(
      (
        await runCorpus(
          { root, phase: "candidate", concurrency: 1 },
          candidateRunner(calls),
        )
      ).code,
    ).toBe(1);
    expect(calls).toHaveLength(0);
    expect(
      read(
        join(dirname(packets[0].file), `${packets[0].packetId}.output.json`),
      ),
    ).toEqual({ complete: false });
  });

  it.each([
    { repair: true, native: false, kind: "partial", passed: true },
    { repair: false, native: false, kind: "partial", passed: false },
    { repair: true, native: true, kind: "partial", passed: false },
    { repair: true, native: false, kind: "empty", passed: false },
    { repair: true, native: false, kind: "duplicate", passed: false },
    { repair: true, native: false, kind: "foreign", passed: false },
    { repair: true, native: false, kind: "packet", passed: false },
  ])(
    "candidate scope permits only a nonempty unique subset for relevant repair: %j",
    async ({ repair, native, kind, passed }) => {
      const { root, directory, packets } = fixture(1);
      const blocks = Array.from({ length: 6 }, (_, i) => ({
        batchId: id(10 + i),
        messages: [[0, "synthetic", "합성 분석", []]],
      }));
      const source = { packetId: packets[0].packetId, blocks };
      const output = {
        packetId: kind === "packet" ? id(99) : source.packetId,
        complete: true,
        blocks: blocks.slice(0, 5).map((b) => ({
          batchId: b.batchId,
          candidates: [],
          noncandidateRanges: [[0, 0]],
          contextIds: [],
        })),
      };
      if (kind === "empty") output.blocks = [];
      if (kind === "duplicate") output.blocks[4] = { ...output.blocks[0] };
      if (kind === "foreign") output.blocks[4].batchId = id(99);
      write(packets[0].file, source);
      const inputPath = native
        ? join(directory, "native", `${source.packetId}.input.json`)
        : packets[0].file;
      const outputPath = inputPath.replace(".input.json", ".output.json");
      write(inputPath, source);
      write(outputPath, output);
      const before = readFileSync(outputPath, "utf8");
      const calls: Launch[] = [];
      const result = await runCorpus(
        { root, phase: "candidate", concurrency: 1, repairRelevant: repair },
        candidateRunner(calls),
      );
      expect(result.code).toBe(passed ? 0 : 1);
      expect(readFileSync(outputPath, "utf8")).toBe(before);
      expect(calls.map((c) => [command(c).script, command(c).args[0]])).toEqual(
        passed ? [["chat-native-batches.ts", "repair-relevant"]] : [],
      );
      if (passed) {
        expect(result.progress.counts).toMatchObject({
          needsContext: 3,
          needsContextCandidates: 1,
        });
        expect(
          Object.values(result.progress.steps).some((r) => r.count === 5),
        ).toBe(true);
      } else
        expect(result.progress.failures?.at(-1)?.errorCode).toBe(
          "output-scope-mismatch",
        );
    },
  );

  it("rejects schema-valid wrong packet scope without importing or overwriting", async () => {
    const { root, packets } = fixture(1);
    write(
      join(dirname(packets[0].file), `${packets[0].packetId}.output.json`),
      candidateOutput(id(99)),
    );
    const calls: Launch[] = [];
    expect(
      (
        await runCorpus(
          { root, phase: "candidate", concurrency: 1 },
          candidateRunner(calls),
        )
      ).code,
    ).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("stops on an import conflict before any subsequent model call", async () => {
    const { root } = fixture(3);
    const calls: Launch[] = [];
    const runner: Runner = async (launch) => {
      if (command(launch).script === "chat-native-batches.ts") {
        calls.push(launch);
        return { code: 1 };
      }
      return candidateRunner(calls)(launch);
    };
    const result = await runCorpus(
      { root, phase: "candidate", concurrency: 1 },
      runner,
    );
    expect(result.code).toBe(1);
    expect(calls.map((call) => command(call).script)).toEqual([
      "chat-codex-run.ts",
      "chat-native-batches.ts",
    ]);
    expect(result.progress.counts.imported).toBe(0);
  });

  it("honors pilot packet limits and refuses changed input snapshots on resume", async () => {
    const { root, packets } = fixture(3);
    const calls: Launch[] = [];
    const options = {
      root,
      phase: "candidate" as const,
      concurrency: 1,
      limitPackets: 1,
    };
    expect((await runCorpus(options, candidateRunner(calls))).code).toBe(0);
    expect(calls).toHaveLength(2);
    write(packets[0].file, { ...read(packets[0].file), newField: "changed" });
    calls.length = 0;
    expect((await runCorpus(options, candidateRunner(calls))).code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("keeps four model calls parallel while serializing native repair/import and quarantine writes", async () => {
    const { root } = fixture(8);
    let active = 0,
      maximum = 0,
      nativeActive = 0,
      nativeMaximum = 0,
      quarantines = 0;
    const runner: Runner = async (launch) => {
      const { script, args } = command(launch);
      if (script === "chat-codex-run.ts") {
        maximum = Math.max(maximum, ++active);
        await new Promise((done) => setTimeout(done, 5));
        write(args[2], candidateOutput(read(args[1]).packetId));
        active--;
      } else if (script === "chat-native-batches.ts") {
        nativeMaximum = Math.max(nativeMaximum, ++nativeActive);
        await new Promise((done) => setTimeout(done, 5));
        nativeActive--;
        if (args[0] === "context-only") {
          quarantines++;
          return { code: 0, stdout: JSON.stringify(contextOnlyReceipt()) };
        }
        if (read(args[1]).packetId === id(1))
          return { code: 1, errorCode: "invalid-native-range" };
        return {
          code: 0,
          stdout: JSON.stringify({
            repaired: true,
            repairCounts: {
              needsContextMessages: 0,
              needsContextCandidates: 0,
            },
          }),
        };
      }
      return { code: 0 };
    };
    const result = await runCorpus(
      {
        root,
        phase: "candidate",
        concurrency: 4,
        repairRelevant: true,
        quarantineInvalidCandidates: true,
      },
      runner,
    );
    expect(result.code).toBe(0);
    expect(maximum).toBe(4);
    expect(nativeMaximum).toBe(1);
    expect(quarantines).toBe(1);
    expect(result.progress.counts).toMatchObject({
      imported: 8,
      quarantinedPackets: 1,
    });
  });

  it("a database failure stops queued imports without quarantining or launching another child", async () => {
    const { root, packets } = fixture(4);
    for (const packet of packets)
      write(
        packet.file.replace(".input.json", ".output.json"),
        candidateOutput(packet.packetId),
      );
    const calls: Launch[] = [];
    const runner: Runner = async (launch) => {
      calls.push(launch);
      await new Promise((done) => setTimeout(done, 5));
      return { code: 1, errorCode: "native-database-busy" };
    };
    const result = await runCorpus(
      {
        root,
        phase: "candidate",
        concurrency: 4,
        repairRelevant: true,
        quarantineInvalidCandidates: true,
      },
      runner,
    );
    expect(result.code).toBe(1);
    expect(calls.map(command)).toHaveLength(1);
    expect(command(calls[0])).toMatchObject({
      script: "chat-native-batches.ts",
      args: ["repair-relevant", expect.any(String)],
    });
    expect(result.progress.failures).toEqual([
      {
        script: "chat-native-batches.ts",
        exitCode: 1,
        errorCode: "native-database-busy",
      },
    ]);
    expect(result.progress.counts.imported).toBe(0);
    for (const packet of packets)
      expect(read(packet.file.replace(".input.json", ".output.json"))).toEqual(
        candidateOutput(packet.packetId),
      );
  });

  it.each([false, true])(
    "empty review skips the model and preserves draftHeld without positive approval (forged=%s)",
    async (forged) => {
      const { root, directory } = fixture(1);
      const input = join(
        directory,
        "editorial-batches",
        `${id(1)}.draft.input.json`,
      );
      const output = input.replace(".input.json", ".output.json");
      const reviewInput = join(
        directory,
        "editorial-batches",
        `${id(2)}.review.input.json`,
      );
      const reviewOutput = reviewInput.replace(".input.json", ".output.json");
      const bundle = join(
        directory,
        "editorial-batches",
        `${id(3)}.bundle.json`,
      );
      const approved = bundle.replace(".bundle.json", ".approved.json");
      const dispositions = bundle.replace(".bundle.json", ".dispositions.json");
      const draftHeld = [
        {
          candidateKey: id(4),
          reasons: ["맥락 확인 필요"],
          stage: "draft",
          independentlyReviewed: false,
        },
      ];
      const calls: Launch[] = [];
      const runner: Runner = async (launch) => {
        calls.push(launch);
        const { script, args } = command(launch);
        if (script === "chat-codex-run.ts") {
          expect(args[0]).toBe("draft");
          write(args[2], {
            complete: true,
            entries: [
              {
                candidateKey: id(4),
                title: "합성",
                body: "합성",
                tags: [],
                ready: false,
                quality: false,
                reasons: ["맥락 확인 필요"],
              },
            ],
          });
        } else if (script === "chat-editorial-batches.ts") {
          if (args[0] === "prepare") {
            write(input, { entries: [{ candidateKey: id(4) }] });
            write(join(directory, "editorial-batches/manifest.json"), {
              packets: [{ packetId: id(1), input, output }],
            });
          } else if (args[0] === "review") {
            write(reviewInput, { entries: [], draftHeld });
            return {
              code: 0,
              stdout: JSON.stringify({ reviewInput, reviewOutput }),
            };
          } else if (args[0] === "bundle") {
            expect(read(reviewOutput)).toEqual({ complete: true, entries: [] });
            write(bundle, { entries: [] });
            write(approved, {
              entries: forged ? [{ candidateKey: id(4), passed: true }] : [],
            });
            write(dispositions, { held: 1, draftHeld, reviews: [] });
            return {
              code: 0,
              stdout: JSON.stringify({ bundle, review: approved, held: 1 }),
            };
          }
        } else throw new Error("unexpected helper");
        return { code: 0 };
      };
      const result = await runCorpus(
        { root, phase: "draft", concurrency: 1 },
        runner,
      );
      expect(result.code).toBe(forged ? 1 : 0);
      expect(calls.map((c) => [command(c).script, command(c).args[0]])).toEqual(
        [
          ["chat-editorial-batches.ts", "prepare"],
          ["chat-codex-run.ts", "draft"],
          ["chat-editorial-batches.ts", "review"],
          ["chat-editorial-batches.ts", "bundle"],
        ],
      );
      expect(
        Object.keys(result.progress.steps).some((k) => k.startsWith("review:")),
      ).toBe(false);
      expect(result.progress.counts.reviewed).toBe(0);
      if (forged) {
        expect(result.progress.steps[`bundle:${id(1)}`]).toBeUndefined();
        expect(result.progress.failures?.at(-1)?.errorCode).toBe(
          "invalid-empty-review-bundle",
        );
        return;
      }
      expect(read(dispositions)).toEqual({ held: 1, draftHeld, reviews: [] });
      expect(result.progress.counts).toMatchObject({
        reviewed: 0,
        published: 0,
        held: 1,
      });
      expect(result.progress.steps[`bundle:${id(1)}`]).toMatchObject({
        count: 0,
        held: 1,
      });
      // Publish resumes with an empty review output recreated locally, without model or HTTP calls.
      rmSync(reviewOutput);
      calls.length = 0;
      const publish = await runCorpus(
        { root, phase: "publish", concurrency: 1 },
        runner,
      );
      expect(publish.code).toBe(0);
      expect(calls.map((c) => [command(c).script, command(c).args[0]])).toEqual(
        [
          ["chat-editorial-batches.ts", "review"],
          ["chat-editorial-batches.ts", "bundle"],
        ],
      );
      expect(publish.progress.counts).toMatchObject({
        reviewed: 0,
        published: 0,
        held: 1,
      });
      expect(
        Object.keys(publish.progress.steps).some((k) =>
          /^(review|publish):/.test(k),
        ),
      ).toBe(false);
      // A pre-existing positive response for an empty source is rejected, never overwritten.
      const unexpected = {
        complete: true,
        entries: [
          {
            candidateKey: id(4),
            publicHash: id(5),
            passed: true,
            meaning: true,
            privacy: true,
            rights: true,
            externalTransfer: true,
            reasons: [],
          },
        ],
      };
      write(reviewOutput, unexpected);
      calls.length = 0;
      expect(
        (await runCorpus({ root, phase: "draft", concurrency: 1 }, runner))
          .code,
      ).toBe(1);
      expect(read(reviewOutput)).toEqual(unexpected);
      expect(
        calls.every((c) => command(c).script !== "chat-codex-run.ts"),
      ).toBe(true);
      expect(calls.some((c) => command(c).args[0] === "bundle")).toBe(false);
    },
  );

  it("refreshes legacy private schemas and runs draft, independent review, bundle and publish in order", async () => {
    const { root, directory } = fixture(1);
    const input = join(
      directory,
      "editorial-batches",
      `${id(1)}.draft.input.json`,
    );
    const output = input.replace(".input.json", ".output.json");
    const reviewInput = join(
      directory,
      "editorial-batches",
      `${id(2)}.review.input.json`,
    );
    const reviewOutput = reviewInput.replace(".input.json", ".output.json");
    const bundle = join(directory, "editorial-batches", `${id(3)}.bundle.json`);
    const approved = bundle.replace(".bundle.json", ".approved.json");
    for (const mode of ["draft", "review"]) {
      const path = join(directory, "schemas", `${mode}.schema.json`);
      const legacy = read(path);
      delete legacy.properties.entries.items.properties.quality;
      delete legacy.properties.entries.items.properties.qualityPolicyVersion;
      legacy.properties.entries.items.required =
        legacy.properties.entries.items.required.filter(
          (key: string) => !["quality", "qualityPolicyVersion"].includes(key),
        );
      write(path, legacy);
    }
    const calls: Launch[] = [];
    const runner: Runner = async (launch) => {
      calls.push(launch);
      const { script, args } = command(launch);
      if (script === "chat-codex-run.ts") {
        if (args[0] === "draft")
          write(args[2], {
            complete: true,
            entries: [
              {
                candidateKey: id(4),
                title: "Synthetic",
                body: "Synthetic",
                tags: [],
                ready: true,
                quality: true,
                reasons: [],
              },
            ],
          });
        else if (args[0] === "review")
          write(args[2], {
            complete: true,
            entries: [
              {
                candidateKey: id(4),
                publicHash: id(5),
                passed: true,
                quality: true,
                qualityPolicyVersion,
                meaning: true,
                privacy: true,
                rights: true,
                externalTransfer: true,
                reasons: [],
              },
            ],
          });
      } else if (script === "chat-editorial-batches.ts") {
        if (args[0] === "prepare") {
          write(input, { entries: [{ candidateKey: id(4) }] });
          write(join(directory, "editorial-batches/manifest.json"), {
            packets: [{ packetId: id(1), input, output }],
          });
        } else if (args[0] === "review") {
          write(reviewInput, {
            entries: [{ candidateKey: id(4), publicHash: id(5) }],
          });
          return {
            code: 0,
            stdout: JSON.stringify({ reviewInput, reviewOutput }),
          };
        } else if (args[0] === "bundle") {
          write(bundle, { entries: [{ candidateKey: id(4) }] });
          write(approved, { entries: [{ candidateKey: id(4) }] });
          return {
            code: 0,
            stdout: JSON.stringify({ bundle, review: approved, held: 0 }),
          };
        }
      } else if (script === "publish-editorial.ts")
        return {
          code: 0,
          stdout: JSON.stringify({ published: 0, held: 1, errors: 0 }),
        };
      return { code: 0 };
    };
    const draftResult = await runCorpus(
      { root, phase: "draft", concurrency: 2 },
      runner,
    );
    expect(draftResult.progress.failures ?? []).toEqual([]);
    expect(draftResult.code).toBe(0);
    expect(
      read(join(directory, "schemas/draft.schema.json")).properties.entries
        .items.required,
    ).toContain("quality");
    expect(
      read(join(directory, "schemas/review.schema.json")).properties.entries
        .items.required,
    ).toContain("qualityPolicyVersion");
    expect(calls.map((call) => command(call).args[0])).toEqual([
      "prepare",
      "draft",
      "review",
      "review",
      "bundle",
    ]);
    calls.length = 0;
    const result = await runCorpus(
      { root, phase: "publish", concurrency: 2, publishEnvFile: true },
      runner,
    );
    expect(result.code).toBe(0);
    expect(result.progress.counts).toMatchObject({
      published: 0,
      held: 1,
      reviewed: 1,
    });
    expect(calls.map((call) => command(call).script)).toEqual([
      "chat-editorial-batches.ts",
      "chat-editorial-batches.ts",
      "publish-editorial.ts",
    ]);
    expect(calls.at(-1)?.args[0]).toBe("--env-file=.env");
    expect(
      calls
        .slice(0, -1)
        .every((call) => !call.args.includes("--env-file=.env")),
    ).toBe(true);
    rmSync(output);
    calls.length = 0;
    expect(
      (await runCorpus({ root, phase: "publish", concurrency: 2 }, runner))
        .code,
    ).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
