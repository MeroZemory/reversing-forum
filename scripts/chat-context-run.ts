import {
  copyFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  contextRecoveryDigest,
  type ContextRecoveryInput,
} from "../src/server/chat-pipeline/job-store";
import { hash } from "../src/server/chat-pipeline/prepare";
import { nodeRunner, type Runner } from "./chat-corpus-run";

type Options = {
  concurrency: number;
  retryInvalidOutput?: number;
  quarantineInvalidContext?: boolean;
  solRepair?: boolean;
  limitPackets?: number;
  packetIdsFile?: string;
  root?: string;
  signal?: AbortSignal;
};
type Entry = { packetId: string; file: string; hash: string };
type Step = {
  inputHash: string;
  outputHash: string;
  candidates: number;
  targets: number;
  needsContext: number;
  needsContextCandidates: number;
};
type Failure = { script: string; exitCode: number; errorCode: string };
type Quarantine = {
  inputHash: string;
  outputHash: string;
  errorCode: string;
  targets: number;
  privateOnly: true;
  complete: false;
};
type Progress = {
  version: 1;
  steps: Record<string, Step>;
  quarantined?: Record<string, Quarantine>;
  failure?: Failure;
};
type Output = {
  packetId: string;
  complete: boolean;
  blocks: Array<{
    batchId: string;
    candidates: Array<{
      questionIds: number[];
      responseIds: number[];
      needsContext: boolean;
    }>;
    noncandidateRanges: number[][];
    contextIds: number[];
  }>;
};
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const number = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const codes = new Set([
  "context-run-step-failed",
  "runner-failed",
  "runner-aborted",
  "codex-process-tree-stop-failed",
  "account-unavailable-or-changed",
  "batch-proxy-budget-boundary",
  "cli-not-found",
  "network-failure",
  "authentication-failure",
  "rate-limit",
  "model-unavailable",
  "invalid-context-run-options",
  "invalid-context-run-packet-ids",
  "unknown-context-run-packet-id",
  "invalid-context-repair-mode",
  "invalid-context-run-progress",
  "invalid-context-run-manifest",
  "context-run-manifest-hash-mismatch",
  "context-run-input-hash-mismatch",
  "context-run-snapshot-mismatch",
  "invalid-context-run-output",
  "incomplete-output",
  "invalid-context-run-receipt",
  "invalid-context-run-json",
  "context-run-file-overflow",
  "invalid-context-recovery-input",
  "invalid-context-recovery-output",
  "invalid-context-recovery-block",
  "stale-context-recovery-source",
  "stale-context-recovery-input",
  "conflicting-context-recovery-output",
  "out-of-scope-context-recovery-evidence",
  "unrelated-context-recovery-candidate",
  "invalid-context-recovery-range",
  "invalid-candidate-schema",
  "conflicting-message-disposition",
  "invalid-output-dispositions",
  "duplicate-local-id",
  "raw-source-reproduction",
  "native-database-busy",
  "stopped",
]);
const safeCode = (value: unknown) =>
  typeof value === "string" && codes.has(value)
    ? value
    : "context-run-step-failed";
const retryableOutputs = new Set([
  "invalid-context-run-output",
  "invalid-context-run-json",
  "incomplete-output",
  "conflicting-message-disposition",
  "invalid-output-dispositions",
]);
function readRaw(file: string, maxBytes = 500_000) {
  if (statSync(file).size > maxBytes)
    throw new Error("context-run-file-overflow");
  return readFileSync(file, "utf8");
}
function json(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid-context-run-json");
  }
}
function entries(directory: string): Entry[] {
  const index = json(readRaw(join(directory, "manifest.json")));
  if (
    index?.version !== "chat-context-recovery-v1" ||
    !Array.isArray(index.manifests)
  )
    throw new Error("invalid-context-run-manifest");
  const packets = new Map<string, Entry>();
  for (const part of index.manifests) {
    if (!part || !hex(part.hash) || part.file !== `${part.hash}.manifest.json`)
      throw new Error("invalid-context-run-manifest");
    const raw = readRaw(join(directory, part.file));
    if (contextRecoveryDigest(raw) !== part.hash)
      throw new Error("context-run-manifest-hash-mismatch");
    const shard = json(raw);
    if (!Array.isArray(shard?.packets))
      throw new Error("invalid-context-run-manifest");
    for (const entry of shard.packets) {
      if (
        !entry ||
        !hex(entry.packetId) ||
        !hex(entry.hash) ||
        entry.file !== `${entry.packetId}.input.json`
      )
        throw new Error("invalid-context-run-manifest");
      const previous = packets.get(entry.packetId);
      if (
        previous &&
        (previous.file !== entry.file || previous.hash !== entry.hash)
      )
        throw new Error("invalid-context-run-manifest");
      packets.set(entry.packetId, {
        packetId: entry.packetId,
        file: entry.file,
        hash: entry.hash,
      });
    }
  }
  return [...packets.values()];
}
function inputSnapshot(directory: string, entry: Entry): ContextRecoveryInput {
  const raw = readRaw(join(directory, entry.file));
  if (contextRecoveryDigest(raw) !== entry.hash)
    throw new Error("context-run-input-hash-mismatch");
  const input = json(raw) as ContextRecoveryInput;
  if (
    input?.packetId !== entry.packetId ||
    typeof input.instructions !== "string" ||
    !Array.isArray(input.blocks) ||
    input.blocks.length !== 1 ||
    hash({ instructions: input.instructions, blocks: input.blocks }) !==
      entry.packetId
  )
    throw new Error("context-run-input-hash-mismatch");
  return input;
}
function selectPackets(packets: Entry[], file?: string): Entry[] {
  if (file === undefined) return packets;
  const ids = json(readRaw(file));
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    !ids.every(hex) ||
    new Set(ids).size !== ids.length
  )
    throw new Error("invalid-context-run-packet-ids");
  const byId = new Map(packets.map((entry) => [entry.packetId, entry]));
  return ids.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw new Error("unknown-context-run-packet-id");
    return entry;
  });
}
function outputScope(input: ContextRecoveryInput, raw: string): Output {
  const output = json(raw) as Output;
  if (
    !output ||
    output.packetId !== input.packetId ||
    !Array.isArray(output.blocks) ||
    output.blocks.length !== input.blocks.length ||
    Object.keys(output).sort().join() !== "blocks,complete,packetId"
  )
    throw new Error("invalid-context-run-output");
  if (output.complete !== true) throw new Error("incomplete-output");
  for (const value of output.blocks) {
    const block = input.blocks.find((b) => b.batchId === value?.batchId);
    if (
      !block ||
      !Array.isArray(value.candidates) ||
      !Array.isArray(value.noncandidateRanges) ||
      !Array.isArray(value.contextIds) ||
      Object.keys(value).sort().join() !==
        "batchId,candidates,contextIds,noncandidateRanges"
    )
      throw new Error("invalid-context-run-output");
    const supplied = new Set(block.messages.map((m) => m[0])),
      targets = new Set(block.targetIds);
    const candidateIds = new Set<number>(),
      resolvedIds = new Set<number>(),
      dispositionIds = new Set<number>();
    const valid = (n: unknown, targetOnly = false) =>
      number(n) && supplied.has(n) && (!targetOnly || targets.has(n));
    for (const candidate of value.candidates) {
      if (
        !candidate ||
        !Array.isArray(candidate.questionIds) ||
        !candidate.questionIds.length ||
        !Array.isArray(candidate.responseIds) ||
        typeof candidate.needsContext !== "boolean" ||
        ![...candidate.questionIds, ...candidate.responseIds].every((n) =>
          valid(n),
        ) ||
        (!candidate.needsContext &&
          ![...candidate.questionIds, ...candidate.responseIds].some((n) =>
            targets.has(n),
          ))
      )
        throw new Error("invalid-context-run-output");
      for (const n of [...candidate.questionIds, ...candidate.responseIds]) {
        candidateIds.add(n);
        if (!candidate.needsContext) resolvedIds.add(n);
      }
    }
    for (const range of value.noncandidateRanges) {
      if (
        !Array.isArray(range) ||
        range.length !== 2 ||
        !valid(range[0], true) ||
        !valid(range[1], true) ||
        range[0] > range[1] ||
        range[1] - range[0] >= supplied.size
      )
        throw new Error("invalid-context-run-output");
      for (let n = range[0]; n <= range[1]; n++)
        if (!valid(n, true)) throw new Error("invalid-context-run-output");
        else {
          if (candidateIds.has(n))
            throw new Error("conflicting-message-disposition");
          if (dispositionIds.has(n))
            throw new Error("invalid-output-dispositions");
          dispositionIds.add(n);
        }
    }
    if (!value.contextIds.every((n) => valid(n, true)))
      throw new Error("invalid-context-run-output");
    for (const n of value.contextIds) {
      // Repeated unresolved status is equivalent; a resolved candidate paired
      // with an unresolved status remains a genuine conflict.
      if (resolvedIds.has(n))
        throw new Error("conflicting-message-disposition");
      if (dispositionIds.has(n)) throw new Error("invalid-output-dispositions");
      dispositionIds.add(n);
    }
  }
  return output;
}
export function parseContextOptions(args: string[]): Options {
  const options: Options = { concurrency: 2 };
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--packet-ids") {
      const file = args[i + 1];
      if (!file?.trim() || file.startsWith("--") || options.packetIdsFile)
        throw new Error("invalid-context-run-options");
      options.packetIdsFile = file;
      continue;
    }
    const value = Number(args[i + 1]);
    if (!args[i + 1] || !number(value) || value < 1)
      throw new Error("invalid-context-run-options");
    if (args[i] === "--concurrency" && value <= 4) options.concurrency = value;
    else if (args[i] === "--limit-packets") options.limitPackets = value;
    else if (args[i] === "--retry-invalid-output" && value <= 2)
      options.retryInvalidOutput = value;
    else if (args[i] === "--quarantine-invalid-context" && value === 1)
      options.quarantineInvalidContext = true;
    else if (args[i] === "--sol-repair" && value === 1)
      options.solRepair = true;
    else throw new Error("invalid-context-run-options");
  }
  return options;
}
export async function runContext(
  options: Options,
  runner: Runner = nodeRunner,
) {
  if (
    !number(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 4 ||
    (options.quarantineInvalidContext !== undefined &&
      typeof options.quarantineInvalidContext !== "boolean") ||
    (options.retryInvalidOutput !== undefined &&
      (!number(options.retryInvalidOutput) ||
        options.retryInvalidOutput > 2)) ||
    (options.limitPackets !== undefined &&
      (!number(options.limitPackets) || options.limitPackets < 1)) ||
    (options.packetIdsFile !== undefined &&
      (typeof options.packetIdsFile !== "string" ||
        !options.packetIdsFile.trim()))
  )
    throw new Error("invalid-context-run-options");
  const root = resolve(options.root ?? "."),
    pipeline = join(root, "data/chat-pipeline"),
    directory = join(pipeline, "context-recovery"),
    progressFile = join(pipeline, "context-progress.json");
  const progress: Progress = existsSync(progressFile)
    ? json(readRaw(progressFile, 5_000_000))
    : { version: 1, steps: {} };
  if (
    progress?.version !== 1 ||
    Object.keys(progress).some(
      (key) => !["version", "steps", "quarantined", "failure"].includes(key),
    ) ||
    !progress.steps ||
    typeof progress.steps !== "object" ||
    Array.isArray(progress.steps) ||
    Object.entries(progress.steps).some(
      ([id, step]) =>
        !hex(id) ||
        !step ||
        !hex(step.inputHash) ||
        !hex(step.outputHash) ||
        Object.keys(step).some(
          (key) =>
            ![
              "inputHash",
              "outputHash",
              "candidates",
              "targets",
              "needsContext",
              "needsContextCandidates",
            ].includes(key),
        ) ||
        ![
          step.candidates,
          step.targets,
          step.needsContext,
          step.needsContextCandidates,
        ].every(number) ||
        step.needsContext > step.targets ||
        step.needsContextCandidates > step.candidates,
    ) ||
    (progress.quarantined !== undefined &&
      (!progress.quarantined ||
        typeof progress.quarantined !== "object" ||
        Array.isArray(progress.quarantined) ||
        Object.entries(progress.quarantined).some(
          ([id, held]) =>
            !hex(id) ||
            !!progress.steps[id] ||
            !held ||
            !hex(held.inputHash) ||
            !hex(held.outputHash) ||
            !retryableOutputs.has(held.errorCode) ||
            !number(held.targets) ||
            held.privateOnly !== true ||
            held.complete !== false ||
            Object.keys(held).sort().join() !==
              "complete,errorCode,inputHash,outputHash,privateOnly,targets",
        ))) ||
    (progress.failure &&
      (Object.keys(progress.failure).some(
        (key) => !["script", "exitCode", "errorCode"].includes(key),
      ) ||
        !codes.has(progress.failure.errorCode) ||
        ![
          "chat-context-run.ts",
          "chat-context-recovery.ts",
          "chat-codex-run.ts",
        ].includes(progress.failure.script) ||
        !number(progress.failure.exitCode) ||
        progress.failure.exitCode < 1))
  )
    throw new Error("invalid-context-run-progress");
  const controller = new AbortController();
  let code = 0,
    importTail: Promise<unknown> = Promise.resolve();
  const counts = () => ({
    quarantinedPackets: Object.keys(progress.quarantined ?? {}).length,
    quarantinedTargets: Object.values(progress.quarantined ?? {}).reduce(
      (n, held) => n + held.targets,
      0,
    ),
    importedPackets: Object.keys(progress.steps).length,
    candidates: Object.values(progress.steps).reduce(
      (n, s) => n + s.candidates,
      0,
    ),
    targetPositions: Object.values(progress.steps).reduce(
      (n, s) => n + s.targets,
      0,
    ),
    needsContext: Object.values(progress.steps).reduce(
      (n, s) => n + s.needsContext,
      0,
    ),
    needsContextCandidates: Object.values(progress.steps).reduce(
      (n, s) => n + s.needsContextCandidates,
      0,
    ),
  });
  const checkpoint = () => {
    mkdirSync(pipeline, { recursive: true, mode: 0o700 });
    const temp = `${progressFile}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(progress), { mode: 0o600, flag: "wx" });
    renameSync(temp, progressFile);
  };
  const stop = (script: string, exit: number, errorCode: unknown) => {
    if (code) return;
    code = exit === 2 ? 2 : 1;
    progress.failure = {
      script,
      exitCode: number(exit) && exit > 0 ? exit : 1,
      errorCode: safeCode(errorCode),
    };
    controller.abort();
    checkpoint();
  };
  const abort = () => stop("chat-context-run.ts", 1, "runner-aborted");
  options.signal?.addEventListener("abort", abort, { once: true });
  const invoke = async (
    script: "chat-context-recovery.ts" | "chat-codex-run.ts",
    args: string[],
  ) => {
    if (code) throw new Error("stopped");
    let result: Awaited<ReturnType<Runner>>;
    try {
      result = await runner({
        executable: process.execPath,
        args: ["--import", "tsx", join(root, "scripts", script), ...args],
        cwd: root,
        signal: controller.signal,
      });
    } catch (error) {
      stop(script, 1, error instanceof Error ? error.message : undefined);
      throw new Error("stopped");
    }
    if (result.code !== 0) {
      stop(script, result.code, result.errorCode);
      throw new Error("stopped");
    }
    if (code) throw new Error("stopped");
    return result.stdout ?? "";
  };
  try {
    if (options.signal?.aborted) abort();
    await invoke("chat-context-recovery.ts", ["prepare"]);
    const pending = selectPackets(
      entries(directory),
      options.packetIdsFile === undefined
        ? undefined
        : resolve(root, options.packetIdsFile),
    )
      .filter((entry) => {
        inputSnapshot(directory, entry);
        const previous =
          progress.steps[entry.packetId] ??
          (options.quarantineInvalidContext
            ? progress.quarantined?.[entry.packetId]
            : undefined);
        if (!previous) return true;
        const file = join(directory, `${entry.packetId}.output.json`);
        if (
          previous.inputHash !== entry.hash ||
          !existsSync(file) ||
          contextRecoveryDigest(readRaw(file)) !== previous.outputHash
        )
          throw new Error("context-run-snapshot-mismatch");
        return false;
      })
      .slice(0, options.limitPackets);
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(options.concurrency, pending.length) },
        async () => {
          while (!code && next < pending.length) {
            const entry = pending[next++];
            try {
              const inputFile = join(directory, entry.file),
                outputFile = join(directory, `${entry.packetId}.output.json`);
              const input = inputSnapshot(directory, entry);
              let raw = "",
                output: Output | undefined;
              for (let attempt = 0; !output; attempt++) {
                if (!existsSync(outputFile)) {
                  const schema = join(
                    pipeline,
                    "schemas/candidate.schema.json",
                  );
                  if (!existsSync(schema)) {
                    mkdirSync(join(pipeline, "schemas"), {
                      recursive: true,
                      mode: 0o700,
                    });
                    copyFileSync(
                      join(
                        root,
                        "src/server/chat-pipeline/schemas/candidate.schema.json",
                      ),
                      schema,
                      constants.COPYFILE_EXCL,
                    );
                  }
                  await invoke("chat-codex-run.ts", [
                    "candidate",
                    inputFile,
                    outputFile,
                    schema,
                    ...(options.solRepair ? ["--context-repair"] : []),
                  ]);
                }
                inputSnapshot(directory, entry);
                raw = readRaw(outputFile);
                try {
                  output = outputScope(input, raw);
                } catch (error) {
                  const errorCode = error instanceof Error ? error.message : "";
                  if (
                    options.quarantineInvalidContext &&
                    retryableOutputs.has(errorCode)
                  ) {
                    // Keep original input/output paths, bytes and native receipts.
                    // This is a local validation hold, never a successful step.
                    progress.quarantined ??= {};
                    progress.quarantined[entry.packetId] = {
                      inputHash: entry.hash,
                      outputHash: contextRecoveryDigest(raw),
                      errorCode,
                      targets: input.blocks.reduce(
                        (n, block) => n + block.targetIds.length,
                        0,
                      ),
                      privateOnly: true,
                      complete: false,
                    };
                    checkpoint();
                    break;
                  }
                  if (
                    attempt >= (options.retryInvalidOutput ?? 0) ||
                    !retryableOutputs.has(errorCode)
                  )
                    throw error;
                  // Preserve rejected model bytes. A new actual call makes the
                  // decision; no ranges or classifications are silently repaired.
                  const archive = join(directory, "rejected-output");
                  mkdirSync(archive, { recursive: true, mode: 0o700 });
                  renameSync(
                    outputFile,
                    join(
                      archive,
                      `${entry.packetId}.${contextRecoveryDigest(raw)}.${randomUUID()}.${errorCode}.json`,
                    ),
                  );
                }
              }
              if (!output) continue;
              const validOutput = output,
                outputHash = contextRecoveryDigest(raw);
              const imported = importTail.then(async () => {
                inputSnapshot(directory, entry);
                if (contextRecoveryDigest(readRaw(outputFile)) !== outputHash)
                  throw new Error("context-run-snapshot-mismatch");
                const stdout = await invoke("chat-context-recovery.ts", [
                  "import",
                  outputFile,
                ]);
                const receipt = json(stdout.trim().split(/\r?\n/).at(-1) ?? "");
                const candidates = validOutput.blocks.flatMap((b) =>
                  b.candidates.filter((c) =>
                    [...c.questionIds, ...c.responseIds].some((n) =>
                      input.blocks
                        .find((v) => v.batchId === b.batchId)!
                        .targetIds.includes(n),
                    ),
                  ),
                );
                if (
                  receipt?.recoveryId !== entry.packetId ||
                  typeof receipt.replay !== "boolean" ||
                  receipt.imported !== (receipt.replay ? 0 : candidates.length)
                )
                  throw new Error("invalid-context-run-receipt");
                inputSnapshot(directory, entry);
                if (contextRecoveryDigest(readRaw(outputFile)) !== outputHash)
                  throw new Error("context-run-snapshot-mismatch");
                const resolved = new Set(
                  candidates
                    .filter((c) => !c.needsContext)
                    .flatMap((c) => [...c.questionIds, ...c.responseIds]),
                );
                for (const b of validOutput.blocks)
                  for (const [start, end] of b.noncandidateRanges)
                    for (let n = start; n <= end; n++) resolved.add(n);
                const targets = input.blocks.flatMap((b) => b.targetIds);
                progress.steps[entry.packetId] = {
                  inputHash: entry.hash,
                  outputHash,
                  candidates: candidates.length,
                  targets: targets.length,
                  needsContext: targets.filter((n) => !resolved.has(n)).length,
                  needsContextCandidates: candidates.filter(
                    (c) => c.needsContext,
                  ).length,
                };
                delete progress.quarantined?.[entry.packetId];
                delete progress.failure;
                checkpoint();
              });
              importTail = imported.catch(() => {});
              await imported;
            } catch (error) {
              stop(
                "chat-context-run.ts",
                1,
                error instanceof Error ? error.message : undefined,
              );
            }
          }
        },
      ),
    );
    checkpoint();
  } catch (error) {
    stop(
      "chat-context-run.ts",
      1,
      error instanceof Error ? error.message : undefined,
    );
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
  return {
    code: code || (Object.keys(progress.quarantined ?? {}).length ? 1 : 0),
    progress,
    counts: counts(),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const controller = new AbortController(),
    abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  Promise.resolve()
    .then(() =>
      runContext({
        ...parseContextOptions(process.argv.slice(2)),
        signal: controller.signal,
      }),
    )
    .then(({ code, counts }) => {
      console.log(
        JSON.stringify({
          ...counts,
          exitCode: code,
          privateOnly: true,
          fullMeaningComplete: false,
        }),
      );
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        safeCode(error instanceof Error ? error.message : undefined),
      );
      process.exitCode = 1;
    })
    .finally(() => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    });
}
