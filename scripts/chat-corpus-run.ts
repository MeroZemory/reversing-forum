import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Json = Record<string, any>;
type Phase = "candidate" | "draft" | "publish" | "all";
export type Launch = {
  executable: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
};
export type Runner = (
  launch: Launch,
) => Promise<{ code: number; stdout?: string; errorCode?: string }>;
export type Options = {
  phase: Phase;
  concurrency: number;
  limitPackets?: number;
  publishEnvFile?: boolean;
  repairRelevant?: boolean;
  root?: string;
};
type Receipt = {
  hash: string;
  count: number;
  published?: number;
  held?: number;
  needsContext?: number;
  needsContextCandidates?: number;
};
type Progress = {
  version: 1;
  steps: Record<string, Receipt>;
  failures?: Array<{ script: string; exitCode: number; errorCode?: string }>;
  counts: {
    imported: number;
    reviewed: number;
    published: number;
    held: number;
    needsContext?: number;
    needsContextCandidates?: number;
  };
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const read = (path: string): Json => JSON.parse(readFileSync(path, "utf8"));

const failureScripts = new Set([
  "chat-corpus-run.ts",
  "chat-codex-run.ts",
  "chat-native-batches.ts",
  "chat-editorial-batches.ts",
  "publish-editorial.ts",
]);
// Only fixed diagnostic labels leave child output; arbitrary a-z text is not safe.
const failureCodes = new Set([
  "runner-failed",
  "corpus-step-failed",
  "account-unavailable-or-changed",
  "batch-proxy-budget-boundary",
  "cli-not-found",
  "codex-input-overflow",
  "unsupported-mcp-config-shape",
  "unsupported-mcp-override-name",
  "invalid-mcp-transport",
  "invalid-json-schema",
  "invalid-config",
  "unsupported-feature",
  "unsupported-reasoning-effort",
  "code-mode-configuration",
  "sandbox-failure",
  "authentication-failure",
  "rate-limit",
  "model-unavailable",
  "network-failure",
  "argument-error",
  "output-file-failure",
  "unclassified-cli-diagnostic",
  "invalid-native-envelope",
  "invalid-native-block",
  "invalid-native-range",
  "invalid-native-triage",
  "invalid-native-json",
  "invalid-candidate-schema",
  "out-of-scope-native-evidence",
  "out-of-scope-native-block",
  "out-of-scope-native-packet",
  "native-input-hash-mismatch",
  "native-batch-input-mismatch",
  "native-manifest-mismatch",
  "relevant-manifest-mismatch",
  "relevant-input-mismatch",
  "repair-artifact-conflict",
  "repair-source-path-conflict",
  "native-format-failed",
  "native-initialization-failed",
  "conflicting-message-disposition",
  "incomplete-message-dispositions",
  "invalid-output-dispositions",
  "out-of-scope-evidence",
  "duplicate-local-id",
  "raw-source-reproduction",
  "output-overflow",
  "candidate-overflow",
  "native-output-overflow",
  "incomplete-draft-batch",
  "out-of-scope-draft",
  "incomplete-review-batch",
  "processing-record-required",
  "review-snapshot-mismatch",
  "editorial-batch-failed",
  "unsupported-output-schema",
  "invalid-existing-output",
  "incomplete-output",
  "output-scope-mismatch",
  "changed-model-snapshot",
  "invalid-manifest",
  "invalid-packet-path",
  "invalid-repair-receipt",
  "invalid-empty-review-bundle",
  "missing-draft-output",
  "missing-review-output",
  "incomplete-publication",
  "stopped",
]);
const safeCode = (value: unknown): string | undefined =>
  typeof value === "string" &&
  /^[a-z-]+$/.test(value) &&
  failureCodes.has(value)
    ? value
    : undefined;
function diagnosticCode(text: string): string | undefined {
  for (const token of text.match(/[a-z][a-z_-]*/g) ?? []) {
    const code = safeCode(token.replaceAll("_", "-"));
    if (code) return code;
  }
}

// No shell, raw child diagnostics, helper imports, or credential reads here.
export const nodeRunner: Runner = ({ executable, args, cwd, signal }) =>
  new Promise((done) => {
    const child = spawn(executable, args, {
      cwd,
      signal,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + String(chunk)).slice(-65536);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-65536);
    });
    child.on("error", () => done({ code: 1, errorCode: "runner-failed" }));
    child.on("close", (code) =>
      done({
        code: code ?? 1,
        stdout,
        ...(code !== 0
          ? { errorCode: diagnosticCode(stderr) ?? diagnosticCode(stdout) }
          : {}),
      }),
    );
  });

export function parseOptions(args: string[]): Options {
  const phase = args[0] as Phase;
  if (!["candidate", "draft", "publish", "all"].includes(phase))
    throw new Error("invalid-phase");
  const options: Options = { phase, concurrency: 2 };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--publish-env-file") options.publishEnvFile = true;
    else if (args[i] === "--repair-relevant") options.repairRelevant = true;
    else if (args[i] === "--concurrency" || args[i] === "--limit-packets") {
      const key = args[i] === "--concurrency" ? "concurrency" : "limitPackets";
      const value = Number(args[++i]);
      if (
        !Number.isSafeInteger(value) ||
        value < 1 ||
        (key === "concurrency" && value > 4)
      )
        throw new Error("invalid-limit");
      options[key] = value;
    } else throw new Error("invalid-argument");
  }
  return options;
}

// The CLI schemas use only this small JSON Schema subset. Fail closed on
// unknown constraints rather than silently accepting a new schema dialect.
function validate(value: any, schema: Json): void {
  const supported = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
  ]);
  if (Object.keys(schema).some((key) => !supported.has(key)))
    throw new Error("unsupported-output-schema");
  const fail = () => {
    throw new Error("invalid-existing-output");
  };
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    if (schema.required?.some((key: string) => !(key in value))) fail();
    for (const key of Object.keys(value)) {
      if (!schema.properties?.[key]) {
        if (schema.additionalProperties === false) fail();
      } else validate(value[key], schema.properties[key]);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) fail();
    if (
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      fail();
    value.forEach((item: any) => validate(item, schema.items));
  } else if (schema.type === "string") {
    if (
      typeof value !== "string" ||
      value.length < (schema.minLength ?? 0) ||
      value.length > (schema.maxLength ?? Infinity)
    )
      fail();
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") fail();
  } else if (schema.type === "integer") {
    if (
      !Number.isInteger(value) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity)
    )
      fail();
  } else throw new Error("unsupported-output-schema");
}

export async function runCorpus(
  options: Options,
  runner: Runner = nodeRunner,
): Promise<{ code: number; progress: Progress }> {
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 4 ||
    (options.limitPackets !== undefined &&
      (!Number.isSafeInteger(options.limitPackets) || options.limitPackets < 1))
  )
    throw new Error("invalid-limit");
  const root = resolve(options.root ?? ".");
  const directory = join(root, "data/chat-pipeline");
  const schemaDirectory = join(directory, "schemas");
  mkdirSync(schemaDirectory, { recursive: true });
  for (const mode of ["candidate", "draft", "review"]) {
    const local = join(schemaDirectory, `${mode}.schema.json`);
    if (!existsSync(local))
      copyFileSync(
        join(root, "src/server/chat-pipeline/schemas", `${mode}.schema.json`),
        local,
      );
  }
  const progressPath = join(directory, "corpus-progress.json");
  const progress: Progress = existsSync(progressPath)
    ? (read(progressPath) as Progress)
    : {
        version: 1,
        steps: {},
        counts: { imported: 0, reviewed: 0, published: 0, held: 0 },
      };
  if (progress.version !== 1 || !progress.steps || !progress.counts)
    throw new Error("invalid-checkpoint");
  if (
    progress.failures !== undefined &&
    (!Array.isArray(progress.failures) ||
      progress.failures.length > 20 ||
      progress.failures.some(
        (f) =>
          !f ||
          !failureScripts.has(f.script) ||
          !Number.isSafeInteger(f.exitCode) ||
          f.exitCode < 1 ||
          Object.keys(f).some(
            (k) => !["script", "exitCode", "errorCode"].includes(k),
          ) ||
          (f.errorCode !== undefined && !safeCode(f.errorCode)),
      ))
  )
    throw new Error("invalid-checkpoint");
  for (const [key, receipt] of Object.entries(progress.steps)) {
    if (
      !/^(?:candidate|draft|review|import|bundle|publish):[a-f0-9]{64}$/.test(
        key,
      ) ||
      !/^[a-f0-9]{64}$/.test(receipt.hash) ||
      Object.keys(receipt).some(
        (k) =>
          ![
            "hash",
            "count",
            "published",
            "held",
            "needsContext",
            "needsContextCandidates",
          ].includes(k),
      ) ||
      ![
        receipt.count,
        receipt.published ?? 0,
        receipt.held ?? 0,
        receipt.needsContext ?? 0,
        receipt.needsContextCandidates ?? 0,
      ].every((n) => Number.isSafeInteger(n) && n >= 0)
    )
      throw new Error("invalid-checkpoint");
  }
  const controller = new AbortController();
  let code = 0;
  const stop = (exit: number) => {
    if (!code) {
      code = exit === 2 ? 2 : 1;
      controller.abort();
    }
  };
  const privatePath = (path: string) => {
    const full = resolve(root, path);
    const rel = relative(directory, full);
    if (
      !rel ||
      rel.startsWith("..") ||
      !/\.json$/.test(full) ||
      /(?:editorial-session|processing-record|model-budget)\.json$/.test(full)
    )
      throw new Error("invalid-packet-path");
    return full;
  };
  const checkpoint = () => {
    const receipts = Object.entries(progress.steps);
    progress.counts = {
      imported: receipts
        .filter(([key]) => key.startsWith("import:"))
        .reduce((n, [, r]) => n + r.count, 0),
      reviewed: receipts
        .filter(([key]) => key.startsWith("bundle:"))
        .reduce((n, [, r]) => n + r.count, 0),
      published: receipts.reduce((n, [, r]) => n + (r.published ?? 0), 0),
      held: receipts.reduce((n, [, r]) => n + (r.held ?? 0), 0),
      ...(receipts.some(([, r]) => r.needsContext !== undefined)
        ? {
            needsContext: receipts.reduce(
              (n, [, r]) => n + (r.needsContext ?? 0),
              0,
            ),
            needsContextCandidates: receipts.reduce(
              (n, [, r]) => n + (r.needsContextCandidates ?? 0),
              0,
            ),
          }
        : {}),
    };
    mkdirSync(directory, { recursive: true });
    const temp = `${progressPath}.tmp`;
    writeFileSync(temp, JSON.stringify(progress), { mode: 0o600 });
    renameSync(temp, progressPath);
  };
  const invoke = async (script: string, args: string[], publish = false) => {
    if (code) throw new Error("stopped");
    let result: Awaited<ReturnType<Runner>>;
    try {
      result = await runner({
        executable: process.execPath,
        args: [
          ...(publish && options.publishEnvFile ? ["--env-file=.env"] : []),
          "--import",
          "tsx",
          join(root, "scripts", script),
          ...args,
        ],
        cwd: root,
        signal: controller.signal,
      });
    } catch (error) {
      fail(
        script,
        1,
        error instanceof Error
          ? (safeCode(error.message) ?? "runner-failed")
          : "runner-failed",
      );
      throw new Error("child-failed");
    }
    if (result.code !== 0) {
      fail(
        script,
        result.code,
        safeCode(result.errorCode) ?? diagnosticCode(result.stdout ?? ""),
      );
      throw new Error("child-failed");
    }
    if (code) throw new Error("stopped");
    return result.stdout ?? "";
  };
  const fail = (script: string, exitCode: number, errorCode?: string) => {
    if (code) return;
    const exit = Number.isSafeInteger(exitCode) && exitCode > 0 ? exitCode : 1;
    progress.failures = [
      ...(progress.failures ?? []),
      {
        script: basename(script),
        exitCode: exit,
        ...(safeCode(errorCode) ? { errorCode: safeCode(errorCode) } : {}),
      },
    ].slice(-20);
    stop(exit);
    checkpoint();
  };
  const packets = (path: string) => {
    const manifest = read(path);
    if (
      !Array.isArray(manifest.packets) ||
      manifest.packets.some((p: Json) => !/^[a-f0-9]{64}$/.test(p.packetId)) ||
      new Set(manifest.packets.map((p: Json) => p.packetId)).size !==
        manifest.packets.length
    )
      throw new Error("invalid-manifest");
    return manifest.packets.slice(0, options.limitPackets) as Json[];
  };
  const pool = async (items: Json[], work: (item: Json) => Promise<void>) => {
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(options.concurrency, items.length) },
        async () => {
          while (!code && next < items.length) {
            const item = items[next++];
            try {
              await work(item);
            } catch (error) {
              fail(
                "chat-corpus-run.ts",
                1,
                error instanceof Error
                  ? (safeCode(error.message) ?? "corpus-step-failed")
                  : "corpus-step-failed",
              );
            }
          }
        },
      ),
    );
  };
  const model = async (
    mode: "candidate" | "draft" | "review",
    input: string,
    output: string,
  ) => {
    const source = read(input);
    const schema = join(directory, "schemas", `${mode}.schema.json`);
    const emptyReview =
      mode === "review" &&
      Array.isArray(source.entries) &&
      source.entries.length === 0;
    // Existing invalid/partial outputs require operator intervention, never overwrite.
    if (!existsSync(output)) {
      if (emptyReview)
        writeFileSync(output, JSON.stringify({ complete: true, entries: [] }), {
          flag: "wx",
          mode: 0o600,
        });
      else await invoke("chat-codex-run.ts", [mode, input, output, schema]);
    }
    const result = read(output);
    validate(result, read(schema));
    if (result.complete !== true) throw new Error("incomplete-output");
    const key = mode === "candidate" ? "batchId" : "candidateKey";
    const expected = (
      mode === "candidate" ? source.blocks : source.entries
    ).map((e: Json) => e[key]);
    const actual = (mode === "candidate" ? result.blocks : result.entries).map(
      (e: Json) => e[key],
    );
    if (
      expected.length !== actual.length ||
      new Set(actual).size !== actual.length ||
      expected.some((k: string) => !actual.includes(k)) ||
      (mode === "candidate" && result.packetId !== source.packetId)
    )
      throw new Error("output-scope-mismatch");
    if (
      mode === "review" &&
      result.entries.some(
        (entry: Json) =>
          entry.publicHash !==
          source.entries.find(
            (e: Json) => e.candidateKey === entry.candidateKey,
          )?.publicHash,
      )
    )
      throw new Error("review-snapshot-mismatch");
    // Empty transport completion is not an independent semantic review receipt.
    if (emptyReview) return result;
    const modelKey = `${mode}:${digest(relative(directory, input))}`;
    const hash = digest([source, result]);
    if (progress.steps[modelKey] && progress.steps[modelKey].hash !== hash)
      throw new Error("changed-model-snapshot");
    progress.steps[modelKey] = { hash, count: actual.length };
    checkpoint();
    return result;
  };
  const lastJson = (stdout: string) => {
    const lines = stdout.trim().split(/\r?\n/);
    return JSON.parse(lines.at(-1) ?? "") as Json;
  };
  const checkEmptyReviewBundle = (
    input: string,
    bundle: Json,
    review: Json,
    held: number,
  ) => {
    const source = read(input);
    if (
      source.entries.length === 0 &&
      (bundle.entries.length !== 0 ||
        review.entries.length !== 0 ||
        held !== (source.draftHeld ?? []).length)
    )
      throw new Error("invalid-empty-review-bundle");
  };
  try {
    if (options.phase === "candidate" || options.phase === "all") {
      await pool(
        packets(join(directory, "triage/relevant/manifest.json")),
        async (packet) => {
          const nativeOutput = join(
            directory,
            "native",
            `${packet.packetId}.output.json`,
          );
          const original = existsSync(nativeOutput);
          const repair = !original && options.repairRelevant === true;
          const input = original
            ? join(directory, "native", `${packet.packetId}.input.json`)
            : privatePath(
                packet.file ??
                  join(
                    directory,
                    "triage/relevant",
                    `${packet.packetId}.input.json`,
                  ),
              );
          const output = original
            ? nativeOutput
            : join(dirname(input), `${packet.packetId}.output.json`);
          // Candidate generation may run once; the repair/import helper never calls models.
          await model("candidate", input, output);
          const hash = digest([
            read(input),
            read(output),
            original,
            ...(repair ? ["repair-relevant-v1"] : []),
          ]);
          const key = `import:${packet.packetId}`;
          if (progress.steps[key]?.hash !== hash) {
            const stdout = await invoke("chat-native-batches.ts", [
              original
                ? "import"
                : repair
                  ? "repair-relevant"
                  : "import-relevant",
              output,
            ]);
            const repaired = repair ? lastJson(stdout) : undefined;
            if (
              repair &&
              (repaired?.repaired !== true ||
                ![
                  repaired.repairCounts?.needsContextMessages,
                  repaired.repairCounts?.needsContextCandidates,
                ].every((n) => Number.isSafeInteger(n) && n >= 0))
            )
              throw new Error("invalid-repair-receipt");
            progress.steps[key] = {
              hash,
              count: read(output).blocks.length,
              ...(repair
                ? {
                    needsContext: repaired!.repairCounts.needsContextMessages,
                    needsContextCandidates:
                      repaired!.repairCounts.needsContextCandidates,
                  }
                : {}),
            };
            checkpoint();
          }
        },
      );
    }
    if (!code && (options.phase === "draft" || options.phase === "all")) {
      // Helper prepares all candidates in stable groups of twenty. Limit applies
      // to model packets, not candidate selection inside the preparation helper.
      await invoke("chat-editorial-batches.ts", ["prepare"]);
      await pool(
        packets(join(directory, "editorial-batches/manifest.json")),
        async (packet) => {
          const input = privatePath(packet.input);
          const output = privatePath(packet.output);
          await model("draft", input, output);
          const reviewPaths = lastJson(
            await invoke("chat-editorial-batches.ts", [
              "review",
              input,
              output,
            ]),
          );
          const reviewInput = privatePath(reviewPaths.reviewInput);
          const reviewOutput = privatePath(reviewPaths.reviewOutput);
          await model("review", reviewInput, reviewOutput);
          const bundled = lastJson(
            await invoke("chat-editorial-batches.ts", [
              "bundle",
              reviewInput,
              reviewOutput,
            ]),
          );
          const bundle = read(privatePath(bundled.bundle));
          const review = read(privatePath(bundled.review));
          checkEmptyReviewBundle(reviewInput, bundle, review, bundled.held);
          progress.steps[`bundle:${packet.packetId}`] = {
            hash: digest([bundle, review]),
            count: review.entries.length,
            held: bundled.held,
          };
          checkpoint();
        },
      );
    }
    if (!code && (options.phase === "publish" || options.phase === "all")) {
      // Serial HTTP publication; the existing helper owns session and Jev checks.
      for (const packet of packets(
        join(directory, "editorial-batches/manifest.json"),
      )) {
        const input = privatePath(packet.input);
        const output = privatePath(packet.output);
        if (!existsSync(output)) throw new Error("missing-draft-output");
        await model("draft", input, output); // Reuse only: publishing must not launch models.
        const reviewPaths = lastJson(
          await invoke("chat-editorial-batches.ts", ["review", input, output]),
        );
        const reviewInput = privatePath(reviewPaths.reviewInput);
        const reviewOutput = privatePath(reviewPaths.reviewOutput);
        if (
          !existsSync(reviewOutput) &&
          read(reviewInput).entries?.length !== 0
        )
          throw new Error("missing-review-output");
        await model("review", reviewInput, reviewOutput);
        const bundled = lastJson(
          await invoke("chat-editorial-batches.ts", [
            "bundle",
            reviewInput,
            reviewOutput,
          ]),
        );
        const bundlePath = privatePath(bundled.bundle);
        const approvedPath = privatePath(bundled.review);
        checkEmptyReviewBundle(
          reviewInput,
          read(bundlePath),
          read(approvedPath),
          bundled.held,
        );
        const hash = digest([read(bundlePath), read(approvedPath)]);
        progress.steps[`bundle:${packet.packetId}`] = {
          hash,
          count: read(approvedPath).entries.length,
          held: bundled.held,
        };
        if (read(bundlePath).entries.length === 0) {
          checkpoint();
          continue;
        }
        const key = `publish:${packet.packetId}`;
        if (
          progress.steps[key]?.hash === hash &&
          progress.steps[key].held === 0
        )
          continue;
        const result = lastJson(
          await invoke(
            "publish-editorial.ts",
            [bundlePath, approvedPath, "publish"],
            true,
          ),
        );
        if (
          ![result.published, result.held, result.errors].every(
            (n) => Number.isSafeInteger(n) && n >= 0,
          ) ||
          result.errors ||
          result.published + result.held !== read(bundlePath).entries.length
        )
          throw new Error("incomplete-publication");
        progress.steps[key] = {
          hash,
          count: read(bundlePath).entries.length,
          published: result.published,
          held: result.held,
        };
        checkpoint();
      }
    }
  } catch (error) {
    fail(
      "chat-corpus-run.ts",
      1,
      error instanceof Error
        ? (safeCode(error.message) ?? "corpus-step-failed")
        : "corpus-step-failed",
    );
  }
  checkpoint();
  return { code, progress };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCorpus(parseOptions(process.argv.slice(2)))
    .then(({ code, progress }) => {
      console.log(JSON.stringify({ ...progress.counts, exitCode: code }));
      process.exitCode = code;
    })
    .catch(() => {
      console.error("corpus-run-failed");
      process.exitCode = 1;
    });
}
