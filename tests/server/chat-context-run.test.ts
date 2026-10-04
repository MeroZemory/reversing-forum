import { afterEach, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  parseContextOptions,
  runContext,
} from "../../scripts/chat-context-run";
import type { Launch, Runner } from "../../scripts/chat-corpus-run";
import {
  ChatJobStore,
  contextRecoveryDigest,
  type ContextRecoveryInput,
} from "../../src/server/chat-pipeline/job-store";
import {
  hash,
  SANITIZER_VERSION,
} from "../../src/server/chat-pipeline/prepare";
import {
  prepareContextRecovery,
  importContextRecoveryOutput,
} from "../../scripts/chat-context-recovery";

const roots: string[] = [],
  stores: ChatJobStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const id = (n: number) => n.toString(16).padStart(64, "0");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const write = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};
function fixture(count = 3) {
  const root = mkdtempSync(join(tmpdir(), "chat-context-run-synthetic-"));
  roots.push(root);
  const pipeline = join(root, "data/chat-pipeline"),
    directory = join(pipeline, "context-recovery");
  write(
    join(root, "src/server/chat-pipeline/schemas/candidate.schema.json"),
    read(resolve("src/server/chat-pipeline/schemas/candidate.schema.json")),
  );
  const inputs: ContextRecoveryInput[] = Array.from(
    { length: count },
    (_, n) => {
      const blocks: ContextRecoveryInput["blocks"] = [
        {
          batchId: id(n + 1),
          runId: id(100),
          inputHash: id(101),
          outputHash: id(102),
          previousRecoveryIds: [],
          targetIds: [120, 121],
          messages: [
            [118, "synthetic", "앞 문맥", []],
            [120, "synthetic", "분석 질문", []],
            [121, "synthetic", "분석 응답", []],
            [123, "synthetic", "뒤 문맥", []],
          ],
        },
      ];
      return {
        packetId: hash({ instructions: "synthetic", blocks }),
        instructions: "synthetic",
        blocks,
      };
    },
  );
  function prepare(selected = inputs) {
    const packets = selected.map((input) => {
      const file = `${input.packetId}.input.json`,
        raw = JSON.stringify(input);
      const path = join(directory, file);
      if (!readFileExists(path)) write(path, input);
      return {
        packetId: input.packetId,
        file,
        hash: contextRecoveryDigest(raw),
      };
    });
    const raw = JSON.stringify({ packets }),
      digest = contextRecoveryDigest(raw),
      shard = `${digest}.manifest.json`;
    if (!readFileExists(join(directory, shard)))
      write(join(directory, shard), { packets });
    const indexFile = join(directory, "manifest.json"),
      previous = readFileExists(indexFile) ? read(indexFile).manifests : [];
    write(indexFile, {
      version: "chat-context-recovery-v1",
      manifests: [
        ...new Map(
          [...previous, { file: shard, hash: digest }].map((p) => [p.file, p]),
        ).values(),
      ],
    });
  }
  return { root, pipeline, directory, inputs, prepare };
}
function readFileExists(file: string) {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}
const command = (launch: Launch) => {
  const index = launch.args.findIndex((arg) => arg.endsWith(".ts"));
  return {
    script: basename(launch.args[index]),
    args: launch.args.slice(index + 1),
  };
};
function output(input: ContextRecoveryInput, candidate = false) {
  return {
    packetId: input.packetId,
    complete: true,
    blocks: [
      {
        batchId: input.blocks[0].batchId,
        candidates: candidate
          ? [
              {
                localId: "c1",
                title: "합성 분석 질문",
                topic: "분석",
                questionIds: [input.blocks[0].targetIds[0]],
                responseIds: [input.blocks[0].targetIds[1]],
                uncertainties: [],
                needsContext: false,
              },
            ]
          : [],
        noncandidateRanges: [] as number[][],
        contextIds: candidate ? [] : input.blocks[0].targetIds,
      },
    ],
  };
}
function runnerFor(f: ReturnType<typeof fixture>, calls: Launch[]): Runner {
  return async (launch) => {
    calls.push(launch);
    const { script, args } = command(launch);
    if (script === "chat-codex-run.ts") {
      write(args[2], output(read(args[1])));
      return { code: 0 };
    }
    expect(script).toBe("chat-context-recovery.ts");
    if (args[0] === "prepare") {
      f.prepare();
      return { code: 0 };
    }
    const result = read(args[1]);
    return {
      code: 0,
      stdout: JSON.stringify({
        imported: result.blocks[0].candidates.length,
        replay: false,
        recoveryId: result.packetId,
      }),
    };
  };
}

it("bounds concurrency and packet limits without accepting extra flags", () => {
  expect(parseContextOptions([])).toEqual({ concurrency: 2 });
  expect(
    parseContextOptions(["--concurrency", "4", "--limit-packets", "2"]),
  ).toEqual({ concurrency: 4, limitPackets: 2 });
  expect(
    parseContextOptions([
      "--packet-ids",
      "tmp/selected packets.json",
      "--limit-packets",
      "2",
      "--concurrency",
      "4",
    ]),
  ).toEqual({
    concurrency: 4,
    limitPackets: 2,
    packetIdsFile: "tmp/selected packets.json",
  });
  for (const args of [
    ["--concurrency", "5"],
    ["--concurrency", "0"],
    ["--limit-packets", "0"],
    ["--limit-packets", "1.5"],
    ["--limit-packets"],
    ["--repair-relevant", "1"],
    ["--retry-invalid-output", "3"],
    ["--packet-ids"],
    ["--packet-ids", " "],
    ["--packet-ids", "--concurrency", "2"],
    ["--packet-ids", "a.json", "--packet-ids", "b.json"],
  ])
    expect(() => parseContextOptions(args)).toThrow(
      "invalid-context-run-options",
    );
});

it.each([
  "duplicate",
  "uppercase",
  "short",
  "non-string",
  "object",
  "empty",
  "json",
  "unknown",
  "unmanifested",
])("rejects %s selection before any model or import", async (kind) => {
  const f = fixture(2),
    calls: Launch[] = [],
    file = join(f.root, "selected.json"),
    selected = f.inputs[0].packetId;
  const values: Record<string, unknown> = {
    duplicate: [selected, selected],
    uppercase: [selected.toUpperCase()],
    short: ["abc"],
    "non-string": [42],
    object: { packetIds: [selected] },
    empty: [],
    json: [selected],
    unknown: [selected, id(900)],
    unmanifested: [selected, id(900)],
  };
  write(file, values[kind]);
  if (kind === "json") writeFileSync(file, "[invalid json");
  if (kind === "unmanifested")
    write(join(f.directory, `${id(900)}.input.json`), f.inputs[0]);
  const result = await runContext(
    { root: f.root, concurrency: 2, limitPackets: 1, packetIdsFile: file },
    runnerFor(f, calls),
  );
  expect(result.code).toBe(1);
  expect(result.counts.importedPackets).toBe(0);
  expect(result.progress.failure?.errorCode).toBe(
    kind === "json"
      ? "invalid-context-run-json"
      : ["unknown", "unmanifested"].includes(kind)
        ? "unknown-context-run-packet-id"
        : "invalid-context-run-packet-ids",
  );
  expect(calls.map(command).map((c) => c.args[0])).toEqual(["prepare"]);
});

it.each([
  "packet-id",
  "content-id",
  "input-hash",
  "manifest-id",
  "manifest-hash",
])(
  "preflights selected %s mismatch beyond the packet limit with zero model calls",
  async (kind) => {
    const f = fixture(2),
      calls: Launch[] = [],
      file = join(f.root, "selected.json"),
      base = runnerFor(f, calls);
    write(
      file,
      f.inputs.map((input) => input.packetId),
    );
    const result = await runContext(
      { root: f.root, concurrency: 2, limitPackets: 1, packetIdsFile: file },
      async (launch) => {
        const result = await base(launch);
        if (command(launch).args[0] !== "prepare") return result;
        const indexFile = join(f.directory, "manifest.json"),
          index = read(indexFile),
          part = index.manifests[0],
          shardFile = join(f.directory, part.file),
          shard = read(shardFile),
          entry = shard.packets[1],
          inputFile = join(f.directory, entry.file),
          input = read(inputFile);
        if (kind === "manifest-hash") {
          write(shardFile, { packets: [] });
          return result;
        }
        if (kind === "manifest-id") {
          entry.packetId = id(900);
          entry.file = `${entry.packetId}.input.json`;
          write(join(f.directory, entry.file), input);
          write(file, [f.inputs[0].packetId, entry.packetId]);
        } else {
          if (kind === "packet-id") input.packetId = id(900);
          else input.instructions = "changed synthetic instructions";
          write(inputFile, input);
          if (kind === "input-hash") return result;
          entry.hash = contextRecoveryDigest(readFileSync(inputFile, "utf8"));
        }
        const raw = JSON.stringify(shard),
          digest = contextRecoveryDigest(raw);
        write(join(f.directory, `${digest}.manifest.json`), shard);
        index.manifests = [{ file: `${digest}.manifest.json`, hash: digest }];
        write(indexFile, index);
        return result;
      },
    );
    expect(result.code).toBe(1);
    expect(result.progress.failure?.errorCode).toBe(
      kind === "manifest-hash"
        ? "context-run-manifest-hash-mismatch"
        : "context-run-input-hash-mismatch",
    );
    expect(result.counts.importedPackets).toBe(0);
    expect(calls.map(command).map((c) => c.args[0])).toEqual(["prepare"]);
  },
);

it("selects ready packets in list order while preserving fifteen completed steps and four failed outputs", async () => {
  const f = fixture(22),
    calls: Launch[] = [],
    base = runnerFor(f, calls),
    file = join(f.root, "selected packets.json");
  const completed = await runContext(
    { root: f.root, concurrency: 1, limitPackets: 15 },
    base,
  );
  expect(completed.code).toBe(0);
  expect(completed.counts.importedPackets).toBe(15);
  const steps = structuredClone(completed.progress.steps),
    cached = join(f.directory, `${f.inputs[20].packetId}.output.json`);
  write(cached, output(f.inputs[20]));
  const failed = f.inputs.slice(15, 19).map((input) => {
    const path = join(f.directory, `${input.packetId}.output.json`),
      raw = "{synthetic failed output";
    writeFileSync(path, raw);
    return { path, raw };
  });
  write(join(f.pipeline, "context-progress.json"), {
    ...completed.progress,
    failure: {
      script: "chat-codex-run.ts",
      exitCode: 1,
      errorCode: "network-failure",
    },
  });
  write(
    file,
    [0, 20, 19, 21].map((n) => f.inputs[n].packetId),
  );
  calls.length = 0;
  const options = {
    root: f.root,
    concurrency: 4,
    limitPackets: 2,
    packetIdsFile: "selected packets.json",
  };
  const result = await runContext(options, base);
  expect(result.code).toBe(0);
  expect(result.counts).toMatchObject({
    importedPackets: 17,
    needsContext: 34,
    candidates: 0,
  });
  expect(result.progress.steps).toMatchObject(steps);
  expect(
    calls
      .filter((c) => command(c).script === "chat-codex-run.ts")
      .map((c) => read(command(c).args[1]).packetId),
  ).toEqual([f.inputs[19].packetId]);
  expect(readFileSync(cached, "utf8")).toBe(
    JSON.stringify(output(f.inputs[20])),
  );
  for (const { path, raw } of failed)
    expect(readFileSync(path, "utf8")).toBe(raw);
  calls.length = 0;
  expect((await runContext(options, base)).counts.importedPackets).toBe(18);
  expect(
    calls
      .filter((c) => command(c).script === "chat-codex-run.ts")
      .map((c) => read(command(c).args[1]).packetId),
  ).toEqual([f.inputs[21].packetId]);
  calls.length = 0;
  expect((await runContext(options, base)).counts.importedPackets).toBe(18);
  expect(calls.map(command).map((c) => c.args[0])).toEqual(["prepare"]);
  for (const { path, raw } of failed)
    expect(readFileSync(path, "utf8")).toBe(raw);
});

it("explicit repair passes the bounded Sol flag only to the candidate runner", async () => {
  const f = fixture(1),
    calls: Launch[] = [];
  const result = await runContext(
    { root: f.root, concurrency: 1, solRepair: true },
    runnerFor(f, calls),
  );
  expect(result.code).toBe(0);
  expect(
    calls.find((c) => command(c).script === "chat-codex-run.ts")?.args.at(-1),
  ).toBe("--context-repair");
  expect(
    calls
      .filter((c) => command(c).script === "chat-context-recovery.ts")
      .every((c) => !c.args.includes("--context-repair")),
  ).toBe(true);
});

it("prepares immutable shards, limits unfinished packets, reuses valid output and never edits candidate progress", async () => {
  const f = fixture(),
    calls: Launch[] = [];
  const candidateProgress = join(f.pipeline, "candidate-progress.json");
  write(candidateProgress, { synthetic: "unchanged" });
  f.prepare(f.inputs.slice(0, 1));
  const originalShard = read(join(f.directory, "manifest.json")).manifests[0]
    .file;
  const shardBefore = readFileSync(join(f.directory, originalShard), "utf8");
  const cached = join(f.directory, `${f.inputs[0].packetId}.output.json`);
  write(cached, output(f.inputs[0]));
  const cachedBefore = readFileSync(cached, "utf8");
  const runner = runnerFor(f, calls),
    options = { root: f.root, concurrency: 2, limitPackets: 1 };
  const first = await runContext(options, runner);
  expect(first.code).toBe(0);
  expect(first.counts).toMatchObject({
    importedPackets: 1,
    candidates: 0,
    targetPositions: 2,
    needsContext: 2,
  });
  expect(calls.map(command).map((c) => c.script)).toEqual([
    "chat-context-recovery.ts",
    "chat-context-recovery.ts",
  ]);
  expect(readFileSync(cached, "utf8")).toBe(cachedBefore);
  calls.length = 0;
  expect((await runContext(options, runner)).counts.importedPackets).toBe(2);
  expect(
    calls.filter((c) => command(c).script === "chat-codex-run.ts"),
  ).toHaveLength(1);
  const model = command(
    calls.find((c) => command(c).script === "chat-codex-run.ts")!,
  );
  expect(model.args).toEqual([
    "candidate",
    join(f.directory, `${f.inputs[1].packetId}.input.json`),
    join(f.directory, `${f.inputs[1].packetId}.output.json`),
    join(f.pipeline, "schemas/candidate.schema.json"),
  ]);
  expect(
    read(model.args[1]).blocks[0].messages.map((m: unknown[]) => m[0]),
  ).toEqual([118, 120, 121, 123]);
  await runContext(options, runner);
  calls.length = 0;
  expect((await runContext(options, runner)).counts.importedPackets).toBe(3);
  expect(calls.map(command).map((c) => c.args[0])).toEqual(["prepare"]);
  expect(readFileSync(join(f.directory, originalShard), "utf8")).toBe(
    shardBefore,
  );
  expect(read(candidateProgress)).toEqual({ synthetic: "unchanged" });
});

it("keeps model calls bounded at four and strict imports serialized", async () => {
  const f = fixture(8),
    calls: Launch[] = [],
    base = runnerFor(f, calls);
  let models = 0,
    maxModels = 0,
    imports = 0,
    maxImports = 0;
  const runner: Runner = async (launch) => {
    const { script, args } = command(launch);
    if (script === "chat-codex-run.ts") {
      maxModels = Math.max(maxModels, ++models);
      await new Promise((done) => setTimeout(done, 5));
      const result = await base(launch);
      models--;
      return result;
    }
    if (args[0] === "import") {
      maxImports = Math.max(maxImports, ++imports);
      await new Promise((done) => setTimeout(done, 5));
      const result = await base(launch);
      imports--;
      return result;
    }
    return base(launch);
  };
  const result = await runContext({ root: f.root, concurrency: 4 }, runner);
  expect(result.code).toBe(0);
  expect(result.counts).toMatchObject({ importedPackets: 8, needsContext: 16 });
  expect(maxModels).toBe(4);
  expect(maxImports).toBe(1);
});

it.each([
  "packet",
  "block",
  "evidence",
  "target",
  "range",
  "candidate-context",
  "candidate-range",
  "repeated-context",
  "incomplete",
  "json",
])(
  "existing invalid %s output stops without a paid retry or import",
  async (kind) => {
    const f = fixture(1),
      calls: Launch[] = [],
      input = f.inputs[0],
      file = join(f.directory, `${input.packetId}.output.json`);
    const bad = output(input, true);
    if (kind === "packet") bad.packetId = id(900);
    if (kind === "block") bad.blocks[0].batchId = id(900);
    if (kind === "evidence") bad.blocks[0].candidates[0].questionIds = [0];
    if (kind === "target") bad.blocks[0].contextIds = [118];
    if (kind === "range") bad.blocks[0].noncandidateRanges = [[120, 123]];
    if (kind === "candidate-context") bad.blocks[0].contextIds = [120];
    if (kind === "candidate-range")
      bad.blocks[0].noncandidateRanges = [[120, 120]];
    if (kind === "repeated-context") {
      bad.blocks[0].candidates = [];
      bad.blocks[0].contextIds = [120, 120];
    }
    if (kind === "incomplete") bad.complete = false;
    write(file, bad);
    if (kind === "json") writeFileSync(file, "{invalid synthetic json");
    const before = readFileSync(file, "utf8");
    const result = await runContext(
      { root: f.root, concurrency: 2 },
      runnerFor(f, calls),
    );
    expect(result.code).toBe(1);
    expect(result.counts.importedPackets).toBe(0);
    expect(calls.map(command).map((c) => c.args[0])).toEqual(["prepare"]);
    expect(readFileSync(file, "utf8")).toBe(before);
  },
);

it("explicit bounded retry preserves conflicting output and imports only a new actual runner result", async () => {
  const f = fixture(1),
    calls: Launch[] = [],
    input = f.inputs[0];
  const file = join(f.directory, `${input.packetId}.output.json`);
  const bad = output(input, true);
  bad.blocks[0].contextIds = [input.blocks[0].targetIds[0]];
  write(file, bad);
  const original = readFileSync(file, "utf8");
  const result = await runContext(
    { root: f.root, concurrency: 1, retryInvalidOutput: 1 },
    runnerFor(f, calls),
  );
  expect(result.code).toBe(0);
  expect(result.counts.importedPackets).toBe(1);
  expect(
    calls.filter((c) => command(c).script === "chat-codex-run.ts"),
  ).toHaveLength(1);
  const archive = join(f.directory, "rejected-output");
  const saved = readdirSync(archive);
  expect(saved).toHaveLength(1);
  expect(readFileSync(join(archive, saved[0]), "utf8")).toBe(original);
  expect(read(file)).not.toEqual(bad);
});

it("a repeated invalid model result exhausts the bounded retry without import", async () => {
  const f = fixture(1),
    calls: Launch[] = [],
    input = f.inputs[0];
  const file = join(f.directory, `${input.packetId}.output.json`);
  const bad = output(input, true);
  bad.blocks[0].contextIds = [input.blocks[0].targetIds[0]];
  write(file, bad);
  const base = runnerFor(f, calls);
  const result = await runContext(
    { root: f.root, concurrency: 1, retryInvalidOutput: 1 },
    async (launch) => {
      if (command(launch).script === "chat-codex-run.ts") {
        calls.push(launch);
        write(file, bad);
        return { code: 0 };
      }
      return base(launch);
    },
  );
  expect(result.code).toBe(1);
  expect(result.counts.importedPackets).toBe(0);
  expect(result.progress.failure?.errorCode).toBe(
    "conflicting-message-disposition",
  );
  expect(
    calls.filter((c) => command(c).script === "chat-codex-run.ts"),
  ).toHaveLength(1);
  expect(calls.filter((c) => command(c).args[0] === "import")).toHaveLength(0);
  expect(read(file)).toEqual(bad);
});

it("unresolved neighbor-only observations never contribute to candidate or resolved counts", async () => {
  const f = fixture(1),
    calls: Launch[] = [],
    input = f.inputs[0],
    file = join(f.directory, `${input.packetId}.output.json`);
  const value = output(input, true);
  value.blocks[0].candidates[0].questionIds = [118];
  value.blocks[0].candidates[0].responseIds = [];
  value.blocks[0].candidates[0].needsContext = true;
  write(file, value);
  const base = runnerFor(f, calls);
  const result = await runContext(
    { root: f.root, concurrency: 1 },
    async (launch) => {
      if (command(launch).args[0] === "import") {
        calls.push(launch);
        return {
          code: 0,
          stdout: JSON.stringify({
            imported: 0,
            replay: false,
            recoveryId: input.packetId,
          }),
        };
      }
      return base(launch);
    },
  );
  expect(result.code).toBe(0);
  expect(result.counts).toMatchObject({
    candidates: 0,
    needsContext: 2,
    needsContextCandidates: 0,
  });
  expect(read(file)).toEqual(value);
});

it.each(["manifest", "input", "completed-output"])(
  "changed %s hashes stop privately before new model work",
  async (kind) => {
    const f = fixture(1),
      calls: Launch[] = [],
      base = runnerFor(f, calls);
    if (kind === "completed-output") {
      expect(
        (await runContext({ root: f.root, concurrency: 1 }, base)).code,
      ).toBe(0);
      write(
        join(f.directory, `${f.inputs[0].packetId}.output.json`),
        output(f.inputs[0], true),
      );
      calls.length = 0;
    }
    const runner: Runner = async (launch) => {
      const result = await base(launch);
      if (command(launch).args[0] === "prepare") {
        if (kind === "manifest")
          write(
            join(
              f.directory,
              read(join(f.directory, "manifest.json")).manifests[0].file,
            ),
            { packets: [] },
          );
        if (kind === "input")
          write(join(f.directory, `${f.inputs[0].packetId}.input.json`), {
            ...f.inputs[0],
            instructions: "changed",
          });
      }
      return result;
    };
    expect(
      (await runContext({ root: f.root, concurrency: 1 }, runner)).code,
    ).toBe(1);
    expect(calls.map(command).map((c) => c.args[0])).toEqual(["prepare"]);
  },
);

it.each([2, 1])(
  "budget/account exit %i aborts active models, never imports even a written output, and logs safe labels only",
  async (exit) => {
    const f = fixture(8),
      calls: Launch[] = [],
      base = runnerFor(f, calls);
    let first = true;
    const runner: Runner = async (launch) => {
      if (command(launch).script !== "chat-codex-run.ts") return base(launch);
      calls.push(launch);
      if (first) {
        first = false;
        const { args } = command(launch);
        write(args[2], output(read(args[1])));
        await new Promise((done) => setTimeout(done, 5));
        return {
          code: exit,
          errorCode:
            exit === 2
              ? "batch-proxy-budget-boundary"
              : "account-unavailable-or-changed",
          stdout: "synthetic private prompt test@example.com",
        };
      }
      await new Promise<void>((done) =>
        launch.signal.addEventListener("abort", () => done(), { once: true }),
      );
      return { code: 1, errorCode: "runner-aborted" };
    };
    const result = await runContext({ root: f.root, concurrency: 4 }, runner);
    expect(result.code).toBe(exit);
    expect(result.counts.importedPackets).toBe(0);
    expect(
      calls.filter((c) => command(c).script === "chat-codex-run.ts"),
    ).toHaveLength(4);
    expect(calls.every((c) => c.signal.aborted)).toBe(true);
    expect(calls.some((c) => command(c).args[0] === "import")).toBe(false);
    expect(JSON.stringify(result.progress)).not.toContain("test@example.com");
    expect(JSON.stringify(result.progress)).not.toContain("private prompt");
  },
);

it("stale strict import stops queued packets without any fallback or fabricated receipt", async () => {
  const f = fixture(4),
    calls: Launch[] = [],
    base = runnerFor(f, calls);
  for (const input of f.inputs)
    write(join(f.directory, `${input.packetId}.output.json`), output(input));
  const runner: Runner = async (launch) => {
    if (command(launch).args[0] !== "import") return base(launch);
    calls.push(launch);
    return { code: 1, errorCode: "stale-context-recovery-input" };
  };
  const result = await runContext({ root: f.root, concurrency: 4 }, runner);
  expect(result.code).toBe(1);
  expect(result.progress.failure).toMatchObject({
    script: "chat-context-recovery.ts",
    errorCode: "stale-context-recovery-input",
  });
  expect(result.counts.importedPackets).toBe(0);
  expect(calls.map(command).map((c) => c.args[0])).toEqual([
    "prepare",
    "import",
  ]);
});

it.each([false, true])(
  "strict helpers recover full candidate evidence after partial=%s and preserve idempotent replay",
  async (partial) => {
    const f = fixture(0),
      store = new ChatJobStore(f.pipeline);
    stores.push(store);
    store.prepare(
      [
        {
          id: "synthetic-linking",
          bytes: new TextEncoder().encode(
            "연습방 카카오톡 대화\n--------------- 2026년 10월 2일 금요일 ---------------\n" +
              Array.from(
                { length: 7 },
                (_, n) =>
                  `[가상발언자] [오전 9:${String(n).padStart(2, "0")}] 합성 분석 ${n}\n`,
              ).join(""),
          ),
        },
      ],
      {
        targetPrepared: true,
        scopeApproved: true,
        externalApproved: true,
        sampleReviewed: true,
        scopeVersion: "synthetic-scope",
        reviewScopeVersion: "synthetic-scope",
        reviewRuleVersion: SANITIZER_VERSION,
        externalVersion: "synthetic-external",
        maxMessages: 20,
        overlap: 1,
      },
    );
    const batch = store.listBatches()[0];
    const candidate = {
      localId: "original",
      title: "합성 분석 질문",
      topic: "분석",
      questionIds: [batch.input.messages[3].id],
      responseIds: [batch.input.messages[4].id],
      uncertainties: [],
      needsContext: true,
    };
    store.importResult(
      batch.batchId,
      JSON.stringify({
        batchId: batch.batchId,
        inputHash: batch.inputHash,
        complete: true,
        candidates: [candidate],
        dispositions: batch.input.messages
          .filter((_, n) => ![3, 4].includes(n))
          .map((m) => ({
            messageId: m.id,
            kind: "noncandidate",
            reason: "합성 분류",
          })),
      }),
      { summary: false },
    );
    const db = new Database(join(f.pipeline, "jobs.sqlite"), {
      readonly: true,
    });
    const snapshot = () =>
      JSON.stringify(
        ["jobs", "outputs", "candidate_links"].map((table) =>
          db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ),
      );
    const before = snapshot(),
      calls: Launch[] = [],
      modelInputs: ContextRecoveryInput[] = [];
    const runner: Runner = async (launch) => {
      calls.push(launch);
      const { script, args } = command(launch);
      if (script === "chat-codex-run.ts") {
        const input = read(args[1]);
        modelInputs.push(input);
        expect(input.blocks[0].targetIds).toEqual([3, 4]);
        expect(input.blocks[0].messages.map((m: unknown[]) => m[0])).toEqual([
          1, 2, 3, 4, 5, 6,
        ]);
        const result = output(input, true);
        if (partial && modelInputs.length === 1) {
          result.blocks[0].candidates[0].responseIds = [];
          result.blocks[0].noncandidateRanges = [[4, 4]];
        }
        write(args[2], result);
        return { code: 0 };
      }
      return {
        code: 0,
        stdout: JSON.stringify(
          args[0] === "prepare"
            ? prepareContextRecovery(store, f.directory)
            : importContextRecoveryOutput(store, f.directory, args[1]),
        ),
      };
    };
    try {
      const first = await runContext({ root: f.root, concurrency: 2 }, runner);
      expect(first.code).toBe(0);
      expect(first.counts).toMatchObject({
        importedPackets: 1,
        candidates: 1,
        needsContext: 0,
      });
      expect(store.listCandidates()[0].needsContext).toBe(partial);
      if (partial) {
        const retry = await runContext(
          { root: f.root, concurrency: 2 },
          runner,
        );
        expect(retry.code).toBe(0);
        expect(modelInputs).toHaveLength(2);
        expect(modelInputs[1].packetId).not.toBe(modelInputs[0].packetId);
        expect(modelInputs[1].blocks[0].previousRecoveryIds).toEqual([
          modelInputs[0].packetId,
        ]);
      }
      expect(store.listCandidates()).toHaveLength(1);
      expect(store.listCandidates()[0].needsContext).toBe(false);
      expect(store.listContextRecoveryInputs()).toEqual([]);
      expect(snapshot()).toBe(before);
      expect(
        db.prepare("SELECT candidate_key FROM context_recovery_links").get(),
      ).toEqual(db.prepare("SELECT candidate_key FROM candidate_links").get());
      const linked = JSON.parse(
        (
          db
            .prepare(
              "SELECT record FROM context_recovery_links ORDER BY rowid DESC LIMIT 1",
            )
            .get() as {
            record: string;
          }
        ).record,
      );
      expect(linked.questionIds).toEqual(candidate.questionIds);
      expect(linked.responseIds).toEqual(candidate.responseIds);
      calls.length = 0;
      expect(
        (await runContext({ root: f.root, concurrency: 2 }, runner)).code,
      ).toBe(0);
      expect(calls.map(command).map((c) => c.args[0])).toEqual(["prepare"]);
      rmSync(join(f.pipeline, "context-progress.json"));
      calls.length = 0;
      const replay = await runContext({ root: f.root, concurrency: 2 }, runner);
      expect(replay.counts.candidates).toBe(partial ? 2 : 1);
      expect(calls.map(command).map((c) => c.args[0])).toEqual(
        partial ? ["prepare", "import", "import"] : ["prepare", "import"],
      );
      expect(snapshot()).toBe(before);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM context_recovery_links").get(),
      ).toEqual({ n: partial ? 2 : 1 });
    } finally {
      db.close();
    }
  },
  15_000,
);
