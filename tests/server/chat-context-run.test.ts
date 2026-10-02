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
  for (const args of [
    ["--concurrency", "5"],
    ["--concurrency", "0"],
    ["--limit-packets", "0"],
    ["--limit-packets", "1.5"],
    ["--limit-packets"],
    ["--repair-relevant", "1"],
    ["--retry-invalid-output", "3"],
  ])
    expect(() => parseContextOptions(args)).toThrow(
      "invalid-context-run-options",
    );
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

it("uses the real strict helpers on synthetic jobs, retains full position evidence and links candidates idempotently", async () => {
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
  const db = new Database(join(f.pipeline, "jobs.sqlite"), { readonly: true });
  const snapshot = () =>
    JSON.stringify(
      ["jobs", "outputs", "candidate_links"].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
    );
  const before = snapshot(),
    calls: Launch[] = [];
  const runner: Runner = async (launch) => {
    calls.push(launch);
    const { script, args } = command(launch);
    if (script === "chat-codex-run.ts") {
      const input = read(args[1]);
      expect(input.blocks[0].targetIds).toEqual([3, 4]);
      expect(input.blocks[0].messages.map((m: unknown[]) => m[0])).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      write(args[2], output(input, true));
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
    expect(snapshot()).toBe(before);
    expect(
      db.prepare("SELECT candidate_key FROM context_recovery_links").get(),
    ).toEqual(db.prepare("SELECT candidate_key FROM candidate_links").get());
    const linked = JSON.parse(
      (
        db.prepare("SELECT record FROM context_recovery_links").get() as {
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
    expect(replay.counts.candidates).toBe(1);
    expect(calls.map(command).map((c) => c.args[0])).toEqual([
      "prepare",
      "import",
    ]);
    expect(snapshot()).toBe(before);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM context_recovery_links").get(),
    ).toEqual({ n: 1 });
  } finally {
    db.close();
  }
}, 15_000);
