import { afterEach, describe, expect, it } from "vitest";
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
  parseOptions,
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
  for (const mode of ["candidate", "draft", "review"]) {
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

describe("corpus orchestration boundaries", () => {
  it("prepares schemas from tracked templates without private data from an earlier run", async () => {
    const { root, directory } = fixture(1);
    for (const mode of ["candidate", "draft", "review"])
      rmSync(join(directory, "schemas", `${mode}.schema.json`));
    const result = await runCorpus({ phase: "candidate", concurrency: 1, root }, candidateRunner([]));
    expect(result.code).toBe(0);
    expect(read(join(directory, "schemas/candidate.schema.json"))).toEqual(
      read(join(root, "src/server/chat-pipeline/schemas/candidate.schema.json")),
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
    expect(parseOptions(["all"])).toEqual({ phase: "all", concurrency: 2 });
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

  it("caps active model calls at four", async () => {
    const { root } = fixture(8);
    let active = 0,
      maximum = 0;
    const runner: Runner = async (launch) => {
      const { script, args } = command(launch);
      if (script === "chat-codex-run.ts") {
        maximum = Math.max(maximum, ++active);
        await new Promise((done) => setTimeout(done, 5));
        write(args[2], candidateOutput(read(args[1]).packetId));
        active--;
      }
      return { code: 0 };
    };
    expect(
      (await runCorpus({ root, phase: "candidate", concurrency: 4 }, runner))
        .code,
    ).toBe(0);
    expect(maximum).toBe(4);
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

  it("runs draft, independent review, bundle and HTTP publish in order; reports held separately", async () => {
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
    expect(
      (await runCorpus({ root, phase: "draft", concurrency: 2 }, runner)).code,
    ).toBe(0);
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
