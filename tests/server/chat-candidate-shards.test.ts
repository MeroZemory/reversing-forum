import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startCodexReceipt } from "../../scripts/chat-codex-receipt";
import { runCandidateShards } from "../../scripts/chat-candidate-shards";
import { validate } from "../../scripts/chat-corpus-run";

const callId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const write = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "candidate-shards-"));
  roots.push(root);
  const input = join(root, "input.json"),
    output = join(root, "output.json");
  const schema = join(root, "schema.json"),
    cacheDirectory = join(root, "cache");
  mkdirSync(cacheDirectory);
  write(
    schema,
    read(resolve("src/server/chat-pipeline/schemas/candidate.schema.json")),
  );
  const source = {
    packetId: "a".repeat(64),
    instructions: ["Keep every supplied instruction"],
    blocks: Array.from({ length: 5 }, (_, n) => ({
      batchId: String(n).padStart(64, "0"),
      targetIds: [n * 10],
      messages: [
        [n * 10, "synthetic", `Synthetic evidence ${n}`, [] as string[]],
      ],
    })),
  };
  write(input, source);
  const calls: string[][] = [];
  const resultFor = (child: Pick<typeof source, "packetId" | "blocks">) => ({
    packetId: child.packetId,
    complete: true,
    blocks: child.blocks.map((b) => ({
      batchId: b.batchId,
      candidates: [],
      noncandidateRanges: [[b.targetIds[0], b.targetIds[0]]],
      contextIds: [],
    })),
  });
  const invoke = async (args: string[]) => {
    calls.push(args);
    write(args[2], resultFor(read(args[1])));
  };
  const options = {
    input,
    output,
    schema,
    cacheDirectory,
    receiptDirectory: join(root, "codex-logs"),
    blocksPerShard: 2,
    invoke,
    validate,
  };
  return { source, calls, options, resultFor };
}

describe("whole-block candidate transport shards", () => {
  it.each([false, true])(
    "preserves two deadlines without semantic quarantine or a third call (partial=%s)",
    async (partial) => {
      const { options, calls, resultFor } = fixture();
      const invoke = async (args: string[]) => {
        calls.push(args);
        mkdirSync(options.receiptDirectory, { recursive: true });
        const reservationId = callId(calls.length);
        write(join(options.receiptDirectory, `${reservationId}.receipt.json`), {
          reservationId,
          inputHash: createHash("sha256")
            .update(readFileSync(args[1], "utf8"))
            .digest("hex"),
          exitCode: 1,
          stopReason: "deadline",
          settled: false,
          outputAccepted: false,
        });
        if (partial) {
          const result: any = resultFor(read(args[1]));
          result.blocks[0].contextIds = [999];
          write(args[2], result);
        }
        throw new Error("deadline");
      };
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(
          runCandidateShards({ ...options, invoke }),
        ).rejects.toThrow("deadline");
      const before = readdirSync(options.receiptDirectory).map((name) => [
        name,
        readFileSync(join(options.receiptDirectory, name), "utf8"),
      ]);
      calls.length = 0;
      await expect(
        runCandidateShards({
          ...options,
          invoke,
          quarantineInvalidOutput: true,
          quarantineRejectedRetry: true,
        }),
      ).rejects.toThrow("candidate-shard-attempt-limit");
      expect(calls).toHaveLength(0);
      expect(existsSync(options.output)).toBe(false);
      expect(
        readdirSync(options.receiptDirectory).map((name) => [
          name,
          readFileSync(join(options.receiptDirectory, name), "utf8"),
        ]),
      ).toEqual(before);
      const directory = join(
        options.cacheDirectory,
        readdirSync(options.cacheDirectory)[0],
      );
      expect(
        readdirSync(directory).some((name) =>
          /\.(output|receipt)\.json$/.test(name),
        ),
      ).toBe(false);
      expect(
        readdirSync(directory).filter((name) =>
          name.endsWith(".rejected.json"),
        ),
      ).toHaveLength(partial ? 2 : 0);
    },
  );

  it("counts a returned out-of-scope result after a deadline and quarantines without a third call", async () => {
    const { options, calls, resultFor } = fixture();
    const invoke = async (args: string[]) => {
      calls.push(args);
      mkdirSync(options.receiptDirectory, { recursive: true });
      const reservationId = callId(calls.length);
      write(join(options.receiptDirectory, `${reservationId}.receipt.json`), {
        reservationId,
        inputHash: createHash("sha256")
          .update(readFileSync(args[1], "utf8"))
          .digest("hex"),
        exitCode: calls.length === 1 ? 1 : 0,
        settled: calls.length !== 1,
        outputAccepted: calls.length !== 1,
        finalAccountConfirmed: true,
        stopped: calls.length === 1,
      });
      if (calls.length === 1) throw new Error("deadline");
      const result: any = resultFor(read(args[1]));
      result.blocks[0].contextIds.push(999);
      write(args[2], result);
    };
    const guarded = { ...options, invoke, quarantineInvalidOutput: true };
    await expect(runCandidateShards(guarded)).rejects.toThrow("deadline");
    const deadline = readFileSync(
      join(options.receiptDirectory, `${callId(1)}.receipt.json`),
      "utf8",
    );
    await expect(runCandidateShards(guarded)).rejects.toThrow(
      "candidate-shard-output-invalid",
    );
    expect(calls).toHaveLength(2);
    expect(read(options.output)).toEqual({
      packetId: "a".repeat(64),
      complete: false,
      blocks: [],
    });
    expect(
      readFileSync(
        join(options.receiptDirectory, `${callId(1)}.receipt.json`),
        "utf8",
      ),
    ).toBe(deadline);
    rmSync(options.output);
    calls.length = 0;
    await expect(runCandidateShards(guarded)).rejects.toThrow(
      "candidate-shard-output-invalid",
    );
    expect(calls).toHaveLength(0);
    const directory = join(
      options.cacheDirectory,
      readdirSync(options.cacheDirectory)[0],
    );
    expect(
      readdirSync(directory).some((name) =>
        /\.(output|receipt)\.json$/.test(name),
      ),
    ).toBe(false);
    expect(readdirSync(options.receiptDirectory)).toHaveLength(2);
  });

  it("reuses a valid child cache before consulting exhausted receipt history", async () => {
    const { options, calls, source, resultFor } = fixture();
    source.blocks = source.blocks.slice(0, 1);
    write(options.input, source);
    const invoke = async (args: string[]) => {
      calls.push(args);
      mkdirSync(options.receiptDirectory, { recursive: true });
      const reservationId = callId(calls.length);
      write(join(options.receiptDirectory, `${reservationId}.receipt.json`), {
        reservationId,
        inputHash: createHash("sha256")
          .update(readFileSync(args[1], "utf8"))
          .digest("hex"),
        exitCode: 0,
        settled: true,
        outputAccepted: true,
      });
      const result: any = resultFor(read(args[1]));
      if (calls.length === 1) result.blocks[0].contextIds.push(999);
      write(args[2], result);
    };
    await runCandidateShards({ ...options, invoke });
    expect(calls).toHaveLength(2);
    rmSync(options.output);
    calls.length = 0;
    await runCandidateShards({ ...options, invoke });
    expect(calls).toHaveLength(0);
    expect(read(options.output).complete).toBe(true);
    expect(readdirSync(options.receiptDirectory)).toHaveLength(2);
  });

  it.each(["malformed", "identity", "array-hash", "array-id"])(
    "fails closed on %s receipt history without a model call",
    async (kind) => {
      const { options, calls } = fixture();
      mkdirSync(options.receiptDirectory);
      writeFileSync(
        join(options.receiptDirectory, `${callId(1)}.receipt.json`),
        kind === "malformed"
          ? "{"
          : JSON.stringify({
              inputHash:
                kind === "array-hash" ? ["a".repeat(64)] : "a".repeat(64),
              reservationId:
                kind === "array-id"
                  ? [callId(1)]
                  : kind === "identity"
                    ? callId(2)
                    : callId(1),
            }),
      );
      await expect(runCandidateShards(options)).rejects.toThrow(
        "candidate-shard-history-invalid",
      );
      expect(calls).toHaveLength(0);
      expect(existsSync(options.output)).toBe(false);
    },
  );

  it("excludes and preserves non-call seeds before JSON parsing", async () => {
    const { options, calls } = fixture();
    mkdirSync(options.receiptDirectory);
    const seed = join(options.receiptDirectory, "seed.receipt.json");
    const nonV4 = join(
      options.receiptDirectory,
      "00000000-0000-1000-8000-000000000001.receipt.json",
    );
    writeFileSync(seed, "{");
    writeFileSync(nonV4, "{");
    await runCandidateShards(options);
    expect(calls).toHaveLength(3);
    expect(readFileSync(seed, "utf8")).toBe("{");
    expect(readFileSync(nonV4, "utf8")).toBe("{");
  });

  it("counts two interrupted pending receipts and never invokes again", async () => {
    const { options, calls } = fixture();
    await expect(
      runCandidateShards({
        ...options,
        invoke: async (args) => {
          mkdirSync(options.receiptDirectory, { recursive: true });
          const inputHash = createHash("sha256")
            .update(readFileSync(args[1], "utf8"))
            .digest("hex");
          for (let n = 1; n <= 2; n++)
            startCodexReceipt(
              join(options.receiptDirectory, `${callId(n)}.receipt.json`),
              {
                reservationId: callId(n),
                inputHash,
              },
            );
          throw new Error("interrupted");
        },
      }),
    ).rejects.toThrow("interrupted");
    const before = readdirSync(options.receiptDirectory).map((name) =>
      readFileSync(join(options.receiptDirectory, name), "utf8"),
    );
    for (const selected of [false, true]) {
      await expect(
        runCandidateShards({
          ...options,
          quarantineInvalidOutput: true,
          quarantineRejectedRetry: selected,
        }),
      ).rejects.toThrow("candidate-shard-attempt-limit");
    }
    expect(calls).toHaveLength(0);
    expect(existsSync(options.output)).toBe(false);
    expect(
      readdirSync(options.receiptDirectory).map((name) =>
        readFileSync(join(options.receiptDirectory, name), "utf8"),
      ),
    ).toEqual(before);
  });

  it("fails closed when an array hash would hide one of two actual calls", async () => {
    const { options, calls } = fixture();
    await expect(
      runCandidateShards({
        ...options,
        invoke: async (args) => {
          mkdirSync(options.receiptDirectory, { recursive: true });
          const inputHash = createHash("sha256")
            .update(readFileSync(args[1], "utf8"))
            .digest("hex");
          for (let n = 1; n <= 2; n++)
            write(join(options.receiptDirectory, `${callId(n)}.receipt.json`), {
              reservationId: callId(n),
              inputHash: n === 1 ? inputHash : [inputHash],
              exitCode: 1,
              outputAccepted: false,
              settled: false,
            });
          throw new Error("deadline");
        },
      }),
    ).rejects.toThrow("deadline");
    await expect(runCandidateShards(options)).rejects.toThrow(
      "candidate-shard-history-invalid",
    );
    expect(calls).toHaveLength(0);
    expect(existsSync(options.output)).toBe(false);
  });

  it("refuses local malformed artifacts even with two returned native proofs", async () => {
    const { options, calls } = fixture();
    await expect(
      runCandidateShards({
        ...options,
        quarantineInvalidOutput: true,
        invoke: async (args) => {
          calls.push(args);
          mkdirSync(options.receiptDirectory, { recursive: true });
          write(
            join(
              options.receiptDirectory,
              `${callId(calls.length)}.receipt.json`,
            ),
            {
              reservationId: callId(calls.length),
              inputHash: createHash("sha256")
                .update(readFileSync(args[1], "utf8"))
                .digest("hex"),
              exitCode: 0,
              outputAccepted: true,
              settled: true,
              finalAccountConfirmed: true,
              stopped: false,
            },
          );
          writeFileSync(args[2], "{");
        },
      }),
    ).rejects.toThrow("candidate-shard-cache-invalid");
    expect(calls).toHaveLength(2);
    expect(existsSync(options.output)).toBe(false);
  });

  it("preserves native string instructions and resumes an existing v1 shard receipt", async () => {
    const { options, source, calls, resultFor } = fixture();
    const nativeSource = {
      ...source,
      instructions: "Synthetic native instruction",
    };
    write(options.input, nativeSource);
    const hash = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    const directory = join(
      options.cacheDirectory,
      hash(
        JSON.stringify([
          "candidate-shards-v1",
          readFileSync(options.input, "utf8"),
          readFileSync(options.schema, "utf8"),
          options.blocksPerShard,
        ]),
      ),
    );
    mkdirSync(directory);
    const legacyChild = { ...nativeSource, blocks: source.blocks.slice(0, 2) };
    const childText = JSON.stringify(legacyChild),
      childHash = hash(childText);
    const cachedText = JSON.stringify(resultFor(legacyChild));
    writeFileSync(join(directory, `${childHash}.input.json`), childText);
    writeFileSync(join(directory, `${childHash}.output.json`), cachedText);
    writeFileSync(
      join(directory, `${childHash}.receipt.json`),
      hash(cachedText),
    );
    await runCandidateShards(options);
    expect(calls.map((args) => read(args[1]).blocks.length)).toEqual([2, 1]);
    for (const args of calls) {
      const child = read(args[1]);
      expect(typeof child.instructions).toBe("string");
      expect(
        child.instructions.startsWith(nativeSource.instructions + "\n"),
      ).toBe(true);
      expect(child.instructions).toContain("start <= end");
    }
    expect(
      readFileSync(join(directory, `${childHash}.input.json`), "utf8"),
    ).toBe(childText);
    expect(
      existsSync(join(directory, `${childHash}.transport.input.json`)),
    ).toBe(false);
    expect(read(options.output).blocks).toHaveLength(5);
  });

  it.each([
    "reversed-range",
    "held-endpoint",
    "gap",
    "native-index",
    "block-mapping",
  ])(
    "retries %s once with an actual valid second result and retains the rejected bytes/hash",
    async (kind) => {
      const { options, source, calls, resultFor } = fixture();
      source.blocks = source.blocks.slice(0, 2);
      source.blocks[0].targetIds = [0, 2, 4];
      source.blocks[0].messages = [
        [0, "synthetic", "Synthetic context", []],
        [2, "synthetic", "Synthetic question", []],
        [3, "synthetic", "Synthetic held", ["held"]],
        [4, "synthetic", "Synthetic response", []],
      ];
      write(options.input, source);
      let rejectedText = "",
        acceptedText = "";
      await runCandidateShards({
        ...options,
        invoke: async (args) => {
          calls.push(args);
          const child = read(args[1]);
          const result: any = resultFor(child);
          result.blocks[0].candidates = [
            {
              localId: "synthetic-candidate",
              title: "Synthetic title",
              topic: "Synthetic topic",
              questionIds: [2],
              responseIds: [4],
              uncertainties: [],
              needsContext: false,
            },
          ];
          result.blocks[0].contextIds = [0];
          result.blocks[0].noncandidateRanges = [];
          if (calls.length === 1) {
            if (kind === "reversed-range")
              result.blocks[0].noncandidateRanges = [[4, 2]];
            if (kind === "held-endpoint")
              result.blocks[0].noncandidateRanges = [[3, 4]];
            if (kind === "gap") result.blocks[0].noncandidateRanges = [[0, 2]];
            if (kind === "native-index")
              result.blocks[0].candidates[0].questionIds = [1];
            if (kind === "block-mapping")
              result.blocks[0].candidates[0].questionIds = [10];
            rejectedText = JSON.stringify(result, null, 2) + "\n";
            writeFileSync(args[2], rejectedText);
          } else {
            // The first attempt must be preserved before any retry executes.
            const directory = join(
              options.cacheDirectory,
              readdirSync(options.cacheDirectory)[0],
            );
            const rejected = readdirSync(directory).filter((f) =>
              f.endsWith(".rejected.json"),
            );
            expect(rejected).toHaveLength(1);
            expect(readFileSync(join(directory, rejected[0]), "utf8")).toBe(
              rejectedText,
            );
            expect(rejected[0]).toContain(
              createHash("sha256").update(rejectedText).digest("hex"),
            );
            expect(existsSync(args[2])).toBe(false);
            expect(
              readdirSync(directory).some((f) => f.endsWith(".receipt.json")),
            ).toBe(false);
            result.blocks.reverse();
            acceptedText = JSON.stringify(result, null, 2) + "\n";
            writeFileSync(args[2], acceptedText);
          }
        },
      });
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]);
      expect(read(options.output).blocks).toEqual(
        JSON.parse(acceptedText).blocks.reverse(),
      );
      const directory = join(
        options.cacheDirectory,
        readdirSync(options.cacheDirectory)[0],
      );
      const cached = readdirSync(directory).find((f) =>
        f.endsWith(".output.json"),
      )!;
      expect(readFileSync(join(directory, cached), "utf8")).toBe(acceptedText);
      rmSync(options.output);
      await runCandidateShards(options);
      expect(calls).toHaveLength(2);
    },
  );

  it.each([
    "network-failure",
    "account-unavailable-or-changed",
    "batch-proxy-budget-boundary",
  ])("stops when the single retry encounters %s", async (code) => {
    const { options, calls } = fixture();
    await expect(
      runCandidateShards({
        ...options,
        quarantineInvalidOutput: true,
        invoke: async (args) => {
          calls.push(args);
          writeFileSync(
            args[2],
            calls.length === 1 ? "{" : "failed retry bytes",
          );
          if (calls.length === 2) throw new Error(code);
        },
      }),
    ).rejects.toThrow(code);
    expect(calls).toHaveLength(2);
    expect(existsSync(options.output)).toBe(false);
    const directory = join(
      options.cacheDirectory,
      readdirSync(options.cacheDirectory)[0],
    );
    const files = readdirSync(directory);
    expect(files.filter((f) => f.endsWith(".rejected.json"))).toHaveLength(2);
    expect(files.some((f) => /\.(output|receipt|attempt)\.json$/.test(f))).toBe(
      false,
    );
  });

  it("does not create a quarantine envelope when successful transport returns no output", async () => {
    const { options, calls } = fixture();
    await expect(
      runCandidateShards({
        ...options,
        quarantineInvalidOutput: true,
        invoke: async (args) => {
          calls.push(args);
        },
      }),
    ).rejects.toThrow("candidate-shard-output-invalid");
    expect(calls).toHaveLength(2);
    expect(existsSync(options.output)).toBe(false);
    const directory = join(
      options.cacheDirectory,
      readdirSync(options.cacheDirectory)[0],
    );
    expect(
      readdirSync(directory).some((f) =>
        /\.(output|receipt|rejected)\.json$/.test(f),
      ),
    ).toBe(false);
  });

  it.each([
    "missing",
    "hash",
    "packet",
    "block",
    "malformed",
    "valid",
    "disabled",
  ])(
    "explicit failed-packet recovery rejects %s evidence without another model call",
    async (kind) => {
      const { options, calls, resultFor } = fixture();
      await expect(
        runCandidateShards({
          ...options,
          quarantineInvalidOutput: true,
          invoke: async (args) => {
            calls.push(args);
            if (calls.length >= 2) {
              mkdirSync(options.receiptDirectory, { recursive: true });
              write(
                join(
                  options.receiptDirectory,
                  `${callId(calls.length)}.receipt.json`,
                ),
                {
                  reservationId: callId(calls.length),
                  inputHash: createHash("sha256")
                    .update(readFileSync(args[1], "utf8"))
                    .digest("hex"),
                  exitCode: calls.length === 2 ? 0 : 1,
                  settled: calls.length === 2,
                  outputAccepted: calls.length === 2,
                  finalAccountConfirmed: true,
                  stopped: calls.length !== 2,
                },
              );
            }
            if (calls.length === 3) throw new Error("deadline");
            const result: any = resultFor(read(args[1]));
            if (calls.length === 2) result.blocks[0].contextIds = [999];
            write(args[2], result);
          },
        }),
      ).rejects.toThrow("deadline");
      const directory = join(
        options.cacheDirectory,
        readdirSync(options.cacheDirectory)[0],
      );
      const name = readdirSync(directory).find((f) =>
        f.endsWith(".rejected.json"),
      )!;
      const path = join(directory, name);
      if (kind === "missing") rmSync(path);
      else if (kind === "hash")
        writeFileSync(path, readFileSync(path, "utf8") + "\n");
      else if (kind !== "disabled") {
        const value: any =
          kind === "valid" ? resultFor(read(calls[1][1])) : read(path);
        if (kind === "packet") value.packetId = "b".repeat(64);
        if (kind === "block") value.blocks[0].batchId = "b".repeat(64);
        const text = kind === "malformed" ? "{" : JSON.stringify(value);
        writeFileSync(path, text);
        const parts = name.split(".");
        parts[1] = createHash("sha256").update(text).digest("hex");
        renameSync(path, join(directory, parts.join(".")));
      }
      const before = readdirSync(directory).map((f) => [
        f,
        readFileSync(join(directory, f), "utf8"),
      ]);
      calls.length = 0;
      await expect(
        runCandidateShards({
          ...options,
          quarantineInvalidOutput: kind !== "disabled",
          quarantineRejectedRetry: true,
        }),
      ).rejects.toThrow("candidate-shard-cache-invalid");
      expect(calls).toHaveLength(0);
      expect(existsSync(options.output)).toBe(false);
      expect(
        readdirSync(directory).map((f) => [
          f,
          readFileSync(join(directory, f), "utf8"),
        ]),
      ).toEqual(before);
    },
  );

  it("revalidates cached scope even when the stored output hash matches", async () => {
    const { options, calls } = fixture();
    await runCandidateShards(options);
    rmSync(options.output);
    const directory = join(
      options.cacheDirectory,
      readdirSync(options.cacheDirectory)[0],
    );
    const name = readdirSync(directory).find((f) =>
      f.endsWith(".output.json"),
    )!;
    const path = join(directory, name);
    const result = read(path);
    result.packetId = "b".repeat(64);
    write(path, result);
    writeFileSync(
      join(directory, name.replace(".output.json", ".receipt.json")),
      createHash("sha256").update(readFileSync(path, "utf8")).digest("hex"),
    );
    await expect(runCandidateShards(options)).rejects.toThrow(
      "candidate-shard-cache-invalid",
    );
    expect(calls).toHaveLength(3);
    expect(existsSync(options.output)).toBe(false);
  });

  it("preserves an interrupted attempt and resumes from validated child receipts", async () => {
    const { options, calls } = fixture();
    await expect(
      runCandidateShards({
        ...options,
        invoke: async (args) => {
          if (calls.length === 1) {
            calls.push(args);
            throw new Error("runner-aborted");
          }
          await options.invoke(args);
        },
      }),
    ).rejects.toThrow("runner-aborted");
    // Emulate a process that died before its finally cleanup and final rename.
    write(calls[1][2], { complete: true, blocks: [] });
    writeFileSync(`${options.output}.shards.tmp`, "interrupted assembly");
    await runCandidateShards(options);
    expect(calls).toHaveLength(4);
    expect(read(options.output).blocks).toHaveLength(5);
    expect(existsSync(calls[1][2])).toBe(false);
    const directory = join(
      options.cacheDirectory,
      readdirSync(options.cacheDirectory)[0],
    );
    const rejected = readdirSync(directory).filter((name) =>
      name.endsWith(".rejected.json"),
    );
    expect(rejected).toHaveLength(1);
    expect(read(join(directory, rejected[0]))).toEqual({
      complete: true,
      blocks: [],
    });
    expect(existsSync(`${options.output}.shards.tmp`)).toBe(false);
  });

  it("rejects modified persisted child input before another model call", async () => {
    const { options, calls } = fixture();
    await runCandidateShards(options);
    rmSync(options.output);
    const directory = join(
      options.cacheDirectory,
      readdirSync(options.cacheDirectory)[0],
    );
    const name = readdirSync(directory).find((f) => f.endsWith(".input.json"))!;
    write(join(directory, name), { packetId: "changed", blocks: [] });
    await expect(runCandidateShards(options)).rejects.toThrow(
      "candidate-shard-cache-invalid",
    );
    expect(calls).toHaveLength(3);
    expect(existsSync(options.output)).toBe(false);
  });

  it("rejects ranges crossing unsupplied evidence despite valid endpoint enums", async () => {
    const { options, source, resultFor } = fixture();
    source.blocks = [
      {
        ...source.blocks[0],
        targetIds: [0, 2],
        messages: [
          [0, "synthetic", "Synthetic first", []],
          [2, "synthetic", "Synthetic last", []],
        ],
      },
    ];
    write(options.input, source);
    await expect(
      runCandidateShards({
        ...options,
        invoke: async (args) => {
          const result = resultFor(read(args[1]));
          result.blocks[0].noncandidateRanges = [[0, 2]];
          write(args[2], result);
        },
      }),
    ).rejects.toThrow("candidate-shard-output-invalid");
    expect(existsSync(options.output)).toBe(false);
  });

  it("preserves actual model candidates and restores block order without synthesizing content", async () => {
    const { options, source, resultFor } = fixture();
    const returned: any[] = [];
    await runCandidateShards({
      ...options,
      invoke: async (args) => {
        const child = read(args[1]);
        const result: any = resultFor(child);
        result.blocks[0].candidates = [
          {
            localId: "actual-fake-runner-result",
            title: "Synthetic title",
            topic: "Synthetic topic",
            questionIds: [child.blocks[0].targetIds[0]],
            responseIds: [],
            uncertainties: ["Synthetic uncertainty"],
            needsContext: true,
          },
        ];
        result.blocks[0].noncandidateRanges = [];
        returned.push(...result.blocks);
        result.blocks.reverse();
        write(args[2], result);
      },
    });
    expect(read(options.output).blocks).toEqual(
      source.blocks.map((b) => returned.find((r) => r.batchId === b.batchId)),
    );
  });

  it("splits actual inputs, retains packet/instructions/evidence, joins original order and reuses exact results", async () => {
    const { source, calls, options } = fixture();
    await runCandidateShards(options);
    expect(calls.map((args) => read(args[1]).blocks.length)).toEqual([2, 2, 1]);
    for (const args of calls) {
      expect(args[0]).toBe("candidate");
      expect(args[3]).toBe(options.schema);
      const child = read(args[1]);
      expect(child.packetId).toBe(source.packetId);
      expect(child.instructions.slice(0, source.instructions.length)).toEqual(
        source.instructions,
      );
      expect(child.instructions.join(" ")).toContain(
        "native numeric message IDs",
      );
      expect(child.instructions.join(" ")).toContain("start <= end");
      expect(child.instructions.join(" ")).toContain("held");
      for (const block of child.blocks)
        expect(block).toEqual(
          source.blocks.find((b) => b.batchId === block.batchId),
        );
    }
    expect(read(options.output).blocks.map((b: any) => b.batchId)).toEqual(
      source.blocks.map((b) => b.batchId),
    );
    rmSync(options.output);
    await runCandidateShards(options);
    expect(calls).toHaveLength(3);
  });

  it("invalidates all cached children when any source byte or schema changes", async () => {
    const { calls, options } = fixture();
    await runCandidateShards(options);
    rmSync(options.output);
    writeFileSync(options.input, readFileSync(options.input, "utf8") + "\n");
    await runCandidateShards(options);
    expect(calls).toHaveLength(6);
    rmSync(options.output);
    const schema = read(options.schema);
    schema.properties.packetId.minLength = 64;
    write(options.schema, schema);
    await runCandidateShards(options);
    expect(calls).toHaveLength(9);
  });

  it.each([
    "incomplete",
    "missing",
    "duplicate",
    "packet",
    "foreign-block",
    "cross-block-evidence",
    "foreign-evidence",
    "schema",
    "malformed",
    "absent",
  ])(
    "stops on %s without parent output or caching the failed child",
    async (kind) => {
      const { calls, options, resultFor } = fixture();
      const broken = async (args: string[]) => {
        calls.push(args);
        if (calls.length === 1) {
          write(args[2], resultFor(read(args[1])));
          return;
        }
        const result: any = resultFor(read(args[1]));
        if (kind === "incomplete") result.complete = false;
        if (kind === "missing") result.blocks.pop();
        if (kind === "duplicate") result.blocks[1] = result.blocks[0];
        if (kind === "packet") result.packetId = "b".repeat(64);
        if (kind === "foreign-block") result.blocks[0].batchId = "b".repeat(64);
        if (kind === "cross-block-evidence") result.blocks[0].contextIds = [30];
        if (kind === "foreign-evidence") result.blocks[0].contextIds = [999];
        if (kind === "schema") result.blocks[0].extra = true;
        if (kind === "absent") return;
        if (kind === "malformed") writeFileSync(args[2], "{");
        else write(args[2], result);
      };
      await expect(
        runCandidateShards({ ...options, invoke: broken }),
      ).rejects.toThrow("candidate-shard-output-invalid");
      expect(calls).toHaveLength(3); // One good shard, then exactly two invalid calls.
      expect(existsSync(options.output)).toBe(false);
      const files = readdirSync(
        join(options.cacheDirectory, readdirSync(options.cacheDirectory)[0]),
      );
      expect(files.filter((f) => f.endsWith(".output.json"))).toHaveLength(1);
      expect(files.filter((f) => f.endsWith(".receipt.json"))).toHaveLength(1);
      expect(files.some((f) => f.endsWith(".attempt.json"))).toBe(false);
      expect(files.filter((f) => f.endsWith(".rejected.json"))).toHaveLength(
        kind === "absent" ? 0 : 2,
      );
      await runCandidateShards(options);
      expect(calls).toHaveLength(5); // Only the last two children rerun.
    },
  );

  it.each([
    "network-failure",
    "account-unavailable-or-changed",
    "batch-proxy-budget-boundary",
  ])(
    "propagates %s and preserves rejected transport output without caching it",
    async (code) => {
      const { options, resultFor, calls } = fixture();
      await expect(
        runCandidateShards({
          ...options,
          invoke: async (args) => {
            calls.push(args);
            write(args[2], resultFor(read(args[1])));
            throw new Error(code);
          },
        }),
      ).rejects.toThrow(code);
      expect(calls).toHaveLength(1);
      expect(existsSync(options.output)).toBe(false);
      const files = readdirSync(
        join(options.cacheDirectory, readdirSync(options.cacheDirectory)[0]),
      );
      expect(
        files.filter(
          (f) =>
            f.endsWith(".output.json") ||
            f.endsWith(".receipt.json") ||
            f.endsWith(".attempt.json"),
        ),
      ).toEqual([]);
      expect(files.filter((f) => f.endsWith(".rejected.json"))).toHaveLength(1);
    },
  );

  it("rejects modified cache results and source changes during execution", async () => {
    const { options, calls } = fixture();
    await runCandidateShards(options);
    rmSync(options.output);
    const cache = join(
      options.cacheDirectory,
      readdirSync(options.cacheDirectory)[0],
    );
    const cached = readdirSync(cache).find((f) => f.endsWith(".output.json"))!;
    write(join(cache, cached), { complete: true });
    await expect(runCandidateShards(options)).rejects.toThrow(
      "candidate-shard-cache-invalid",
    );
    expect(calls).toHaveLength(3);
    expect(existsSync(options.output)).toBe(false);

    const fresh = fixture();
    await expect(
      runCandidateShards({
        ...fresh.options,
        invoke: async (args) => {
          await fresh.options.invoke(args);
          writeFileSync(
            fresh.options.input,
            readFileSync(fresh.options.input, "utf8") + "\n",
          );
        },
      }),
    ).rejects.toThrow("candidate-shard-source-changed");
    expect(fresh.calls).toHaveLength(1);
    expect(existsSync(fresh.options.output)).toBe(false);
  });
});
