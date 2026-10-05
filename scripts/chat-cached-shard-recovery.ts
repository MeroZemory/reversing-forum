import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ChatJobStore,
  type ContextRecoveryInput,
} from "../src/server/chat-pipeline/job-store";
import {
  hash,
  validateBatchOutput,
  type PreparedBatch,
  type BatchOutput,
} from "../src/server/chat-pipeline/prepare";
import {
  scopedOutputSchema,
  candidateRelativeContext,
  codexPrompt,
} from "../src/server/chat-pipeline/relative-context";
import {
  buildRelevant,
  validatePacket,
  type Packet,
  type Triage,
} from "./chat-jev-triage";
import { repairRelevantOutput } from "./chat-native-batches";
import { validate } from "./chat-corpus-run";

type Json = Record<string, any>;
const digest = (raw: string | Buffer) =>
  createHash("sha256").update(raw).digest("hex");
const requireThat = (condition: unknown, code: string): void => {
  if (!condition) throw new Error(code);
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
// These private methods already define the strict input/neighbor contract used by import.
type RecoveryStore = {
  contextRecoveryInputs: (
    history: never[],
    selection: { batchId: string; targetIds: number[] },
  ) => ContextRecoveryInput[];
};
function facade(db: Database.Database, directory: string): ChatJobStore {
  return Object.assign(Object.create(ChatJobStore.prototype), {
    db,
    directory,
  });
}
function inputs(store: ChatJobStore, batchId: string, targetIds: number[]) {
  return (store as unknown as RecoveryStore).contextRecoveryInputs([], {
    batchId,
    targetIds,
  });
}
export interface RecoveryOptions {
  packet: string;
  directory: string;
  blocksPerShard: number;
  out: string;
  apply: boolean;
}
export function parseRecoveryOptions(args: string[]): RecoveryOptions {
  const options: RecoveryOptions = {
    packet: "",
    directory: "data/chat-pipeline",
    blocksPerShard: 2,
    out: "",
    apply: false,
  };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    requireThat(!seen.has(flag), "duplicate-recovery-argument");
    seen.add(flag);
    if (flag === "--apply") options.apply = true;
    else {
      const value = args[++i];
      requireThat(
        value && !value.startsWith("--"),
        "invalid-recovery-argument",
      );
      if (flag === "--packet") options.packet = value;
      else if (flag === "--directory") options.directory = value;
      else if (flag === "--blocks-per-shard")
        options.blocksPerShard = Number(value);
      else if (flag === "--out") options.out = value;
      else throw new Error("invalid-recovery-argument");
    }
  }
  checkOptions(options);
  return options;
}
function checkOptions(options: RecoveryOptions) {
  requireThat(/^[a-f0-9]{64}$/.test(options.packet), "invalid-recovery-packet");
  requireThat(
    Number.isSafeInteger(options.blocksPerShard) &&
      options.blocksPerShard >= 1 &&
      options.blocksPerShard <= 6,
    "invalid-recovery-shard-size",
  );
  requireThat(
    options.out.endsWith(".private.json"),
    "private-recovery-out-required",
  );
  const location = relative(resolve(options.directory), resolve(options.out));
  requireThat(
    location.startsWith("..") || isAbsolute(location),
    "recovery-out-inside-runtime",
  );
  requireThat(!existsSync(resolve(options.out)), "recovery-artifact-exists");
}
function project(
  input: ContextRecoveryInput,
  canonical: BatchOutput,
  batch: PreparedBatch,
): string {
  const block = input.blocks[0];
  const supplied = new Set(block.messages.map((m) => m[0]));
  const targets = new Set(block.targetIds);
  const ordinal = new Map(batch.input.messages.map((m, i) => [m.id, i]));
  const heldEvidence = new Set<string>();
  const candidates = canonical.candidates.flatMap((c) => {
    const evidence = [...c.questionIds, ...c.responseIds];
    if (!evidence.some((id) => targets.has(ordinal.get(id)!))) return [];
    if (!evidence.every((id) => supplied.has(ordinal.get(id)!))) {
      evidence.forEach((id) => heldEvidence.add(id));
      return [];
    }
    return [
      {
        ...c,
        questionIds: c.questionIds.map((id) => ordinal.get(id)!),
        responseIds: c.responseIds.map((id) => ordinal.get(id)!),
      },
    ];
  });
  const evidence = new Set(
    candidates.flatMap((c) => [...c.questionIds, ...c.responseIds]),
  );
  const dispositions = new Map(
    canonical.dispositions?.map((d) => [d.messageId, d.kind]),
  );
  const noncandidateRanges: number[][] = [],
    contextIds: number[] = [];
  for (const n of block.targetIds) {
    if (evidence.has(n)) continue;
    const id = batch.input.messages[n].id;
    if (!heldEvidence.has(id) && dispositions.get(id) === "noncandidate")
      noncandidateRanges.push([n, n]);
    else contextIds.push(n);
  }
  return JSON.stringify({
    packetId: input.packetId,
    complete: true,
    blocks: [
      { batchId: block.batchId, candidates, noncandidateRanges, contextIds },
    ],
  });
}

// A small private in-memory copy exercises the existing import API without writing
// to the source DB (or invoking its writable constructor/permission/PRAGMA setup).
export function validationCopy(db: Database.Database, batchIds: string[]) {
  const memory = new Database(":memory:");
  const tables = [
    "runs",
    "jobs",
    "outputs",
    "coverage",
    "candidates",
    "candidate_questions",
    "candidate_links",
    "context_recoveries",
    "context_recovery_links",
  ];
  try {
    for (const table of tables) {
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { sql: string };
      memory.exec(row.sql);
    }
    const insert = (table: string, row: Json) =>
      memory
        .prepare(
          `INSERT OR IGNORE INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(
            row,
          )
            .map(() => "?")
            .join(",")})`,
        )
        .run(...Object.values(row));
    for (const id of batchIds) {
      const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Json;
      insert(
        "runs",
        db.prepare("SELECT * FROM runs WHERE id=?").get(job.run_id) as Json,
      );
      insert("jobs", job);
      for (const table of [
        "outputs",
        "coverage",
        "candidate_links",
        "context_recoveries",
      ]) {
        for (const row of db
          .prepare(`SELECT * FROM ${table} WHERE batch_id=?`)
          .all(id) as Json[])
          insert(table, row);
      }
      for (const link of db
        .prepare("SELECT candidate_key FROM candidate_links WHERE batch_id=?")
        .all(id) as Json[]) {
        insert(
          "candidates",
          db
            .prepare("SELECT * FROM candidates WHERE candidate_key=?")
            .get(link.candidate_key) as Json,
        );
        for (const row of db
          .prepare("SELECT * FROM candidate_questions WHERE candidate_key=?")
          .all(link.candidate_key) as Json[])
          insert("candidate_questions", row);
      }
    }
    // 선택 메시지와 겹치는 외부 활성 held만 보존한다. 외부 output/link는 복사하지 않는다.
    const copiedJobs = new Set(batchIds);
    const overlappingHeld = db.prepare(
      "SELECT c.* FROM coverage selected JOIN coverage c ON c.message_id=selected.message_id JOIN jobs j ON j.id=c.batch_id JOIN runs r ON r.id=j.run_id WHERE selected.batch_id=? AND c.held=1 AND r.active=1",
    );
    for (const id of batchIds) {
      for (const row of overlappingHeld.all(id) as Json[]) {
        if (batchIds.includes(row.batch_id)) continue;
        if (!copiedJobs.has(row.batch_id)) {
          const job = db
            .prepare("SELECT * FROM jobs WHERE id=?")
            .get(row.batch_id) as Json;
          insert(
            "runs",
            db.prepare("SELECT * FROM runs WHERE id=?").get(job.run_id) as Json,
          );
          insert("jobs", job);
          copiedJobs.add(row.batch_id);
        }
        insert("coverage", row);
      }
    }
    return memory;
  } catch (error) {
    memory.close();
    throw error;
  }
}

/** All file/DB checks and dry-run validation precede any durable append. */
export function recoverCachedShards(options: RecoveryOptions) {
  checkOptions(options);
  const directory = resolve(options.directory),
    id = options.packet;
  const db = new Database(join(directory, "jobs.sqlite"), {
    readonly: !options.apply,
    fileMustExist: true,
  });
  const files = new Map<string, string>();
  const read = (file: string) => {
    requireThat(
      statSync(file).isFile() && statSync(file).size <= 5_000_000,
      "recovery-file-invalid",
    );
    const bytes = readFileSync(file),
      text = bytes.toString("utf8");
    requireThat(
      bytes.equals(Buffer.from(text, "utf8")),
      "recovery-invalid-utf8",
    );
    files.set(file, digest(bytes));
    return text;
  };
  const json = (file: string): Json => JSON.parse(read(file));
  const unchanged = () => {
    for (const [file, expected] of files)
      requireThat(
        digest(readFileSync(file)) === expected,
        "recovery-source-changed",
      );
  };
  try {
    return (() => {
      const nativeDirectory = join(directory, "native"),
        relevantDirectory = join(directory, "triage/relevant");
      const packet = json(join(nativeDirectory, `${id}.input.json`)) as Packet;
      validatePacket(packet);
      requireThat(
        packet.packetId === id &&
          hash(packet.blocks) === id &&
          packet.blocks.length >= 1 &&
          packet.blocks.length <= 6,
        "recovery-native-mismatch",
      );
      const nativeManifest = json(join(nativeDirectory, "manifest.json"));
      const nativeEntries = nativeManifest.packets.filter(
        (entry: Json) => entry.packetId === id,
      );
      requireThat(
        nativeEntries.length === 1 &&
          same(
            nativeEntries[0].batchIds,
            packet.blocks.map((b) => b.batchId),
          ),
        "recovery-native-manifest-mismatch",
      );
      const triage = json(
        join(directory, "triage", `${id}.triage.json`),
      ) as Triage;
      const built = buildRelevant(packet, triage);
      const relevantManifest = json(join(relevantDirectory, "manifest.json"));
      const entries = relevantManifest.packets.filter(
        (entry: Json) => entry.packetId === id,
      );
      requireThat(entries.length === 1, "recovery-relevant-manifest-mismatch");
      const entry = entries[0];
      requireThat(
        same(entry.originalBlockIds, nativeEntries[0].batchIds) &&
          same(
            entry.batchIds,
            built.packet.blocks.map((b) => b.batchId),
          ) &&
          same(entry.mapping, built.mapping) &&
          entry.triageComplete === built.triageComplete &&
          entry.lunaExaminedEntirePacket === false,
        "recovery-relevant-manifest-mismatch",
      );
      const sourceText = read(join(relevantDirectory, `${id}.input.json`)),
        source = JSON.parse(sourceText);
      requireThat(
        same(source, built.packet),
        "recovery-relevant-source-mismatch",
      );
      if (entry.file !== undefined)
        requireThat(
          resolve(entry.file) === join(relevantDirectory, `${id}.input.json`),
          "recovery-relevant-path-mismatch",
        );
      const prefix = json(join(relevantDirectory, `${id}.output.json`));
      requireThat(
        prefix.packetId === id &&
          prefix.complete === false &&
          Array.isArray(prefix.blocks) &&
          prefix.blocks.length > 0 &&
          prefix.blocks.length < source.blocks.length &&
          same(Object.keys(prefix).sort(), ["blocks", "complete", "packetId"]),
        "recovery-parent-not-quarantine-prefix",
      );
      const schemaText = read(join(directory, "schemas/candidate.schema.json")),
        schema = JSON.parse(schemaText);
      const cacheDirectory = join(
        directory,
        "candidate-shards",
        digest(
          JSON.stringify([
            "candidate-shards-v1",
            sourceText,
            schemaText,
            options.blocksPerShard,
          ]),
        ),
      );
      requireThat(existsSync(cacheDirectory), "recovery-cache-missing");
      const store = facade(db, directory);
      const batchIds = packet.blocks.map((b) => b.batchId);
      const batches = store.listBatches(batchIds);
      requireThat(batches.length === batchIds.length, "recovery-batch-missing");
      const before = batchIds.map((batchId) => {
        const row = db
          .prepare(
            "SELECT j.*,o.hash AS stored_hash,o.record AS stored_output,r.active FROM jobs j JOIN outputs o ON o.batch_id=j.id JOIN runs r ON r.id=j.run_id WHERE j.id=?",
          )
          .get(batchId) as Json;
        requireThat(
          row &&
            row.active === 1 &&
            row.state === "ready" &&
            row.output_hash === row.stored_hash,
          "recovery-job-version-mismatch",
        );
        const original = JSON.parse(row.stored_output).output;
        const batch = batches.find((b) => b.batchId === batchId)!;
        requireThat(
          row.input_hash === batch.inputHash,
          "recovery-job-version-mismatch",
        );
        validateBatchOutput(JSON.stringify(original), batch);
        requireThat(
          original.candidates.length === 0 &&
            original.dispositions.every(
              (d: Json) => d.kind === "needs-context",
            ),
          "recovery-job-not-quarantined",
        );
        return row;
      });
      const historyBefore = batchIds.map((batchId) => ({
        batchId,
        rows: db
          .prepare(
            "SELECT * FROM context_recoveries WHERE batch_id=? ORDER BY rowid",
          )
          .all(batchId),
      }));
      const receiptDirectory = join(directory, "codex-logs");
      const receiptNames = readdirSync(receiptDirectory).filter((name) =>
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.receipt\.json$/.test(
          name,
        ),
      );
      const accepted: Json[] = [],
        childEvidence: Json[] = [],
        skipped: Json[] = [];
      // A quarantine prefix contains only children completed before the first failure.
      // Do not borrow later caches or rejected bytes as new positive classifications.
      for (
        let offset = 0;
        offset < prefix.blocks.length;
        offset += options.blocksPerShard
      ) {
        const child = {
          ...source,
          blocks: source.blocks.slice(offset, offset + options.blocksPerShard),
        };
        requireThat(
          offset + child.blocks.length <= prefix.blocks.length,
          "recovery-prefix-not-whole-child",
        );
        const childText = JSON.stringify(child),
          childHash = digest(childText);
        const childPath = (suffix: string) =>
          join(cacheDirectory, `${childHash}.${suffix}`);
        requireThat(
          read(childPath("input.json")) === childText,
          "recovery-child-source-mismatch",
        );
        const text = read(childPath("output.json")),
          result = JSON.parse(text);
        requireThat(
          read(childPath("receipt.json")) === digest(text),
          "recovery-local-receipt-mismatch",
        );
        const transportText = read(childPath("transport.input.json")),
          transport = JSON.parse(transportText);
        requireThat(
          same({ ...transport, instructions: child.instructions }, child),
          "recovery-transport-source-mismatch",
        );
        requireThat(
          typeof child.instructions === "string"
            ? typeof transport.instructions === "string" &&
                transport.instructions.startsWith(`${child.instructions}\n`)
            : Array.isArray(transport.instructions) &&
                same(
                  transport.instructions.slice(0, child.instructions.length),
                  child.instructions,
                ),
          "recovery-transport-instructions-mismatch",
        );
        const scoped = scopedOutputSchema(schema, transport, "candidate"),
          scopedText = JSON.stringify(scoped);
        const prompt = codexPrompt(
          transportText,
          candidateRelativeContext(db, transport),
        );
        const witnesses: { name: string; value: Json }[] = [];
        for (const name of receiptNames) {
          const file = join(receiptDirectory, name);
          // Ignore unrelated/unknown receipts, including currently unsettled calls.
          if (statSync(file).size > 100_000) continue;
          let receipt: Json;
          try {
            receipt = JSON.parse(readFileSync(file, "utf8"));
          } catch {
            continue;
          }
          if (receipt?.inputHash !== digest(transportText)) continue;
          receipt = json(file);
          if (
            name === `${receipt.reservationId}.receipt.json` &&
            receipt.actualPromptHash === prompt.actualPromptHash &&
            receipt.actualSchemaHash === digest(scopedText) &&
            receipt.actualSchemaBytes === Buffer.byteLength(scopedText) &&
            receipt.outputAccepted === true &&
            receipt.settled === true &&
            receipt.finalAccountConfirmed === true &&
            receipt.exitCode === 0 &&
            receipt.stopped === false &&
            receipt.attemptOutputExists === true &&
            receipt.attemptOutputBytes === Buffer.byteLength(text)
          )
            witnesses.push({ name, value: receipt });
        }
        requireThat(
          witnesses.length > 0,
          "recovery-accepted-call-receipt-missing",
        );
        requireThat(
          read(join(receiptDirectory, `${digest(scopedText)}.schema.json`)) ===
            scopedText,
          "recovery-scoped-schema-mismatch",
        );
        validate(result, scoped);
        requireThat(
          result.complete === true &&
            result.packetId === id &&
            same(
              result.blocks.map((b: Json) => b.batchId).sort(),
              child.blocks.map((b: Json) => b.batchId).sort(),
            ),
          "recovery-child-block-mismatch",
        );
        for (const supplied of child.blocks) {
          const block = result.blocks.find(
            (b: Json) => b.batchId === supplied.batchId,
          );
          requireThat(
            same(block, prefix.blocks[offset + child.blocks.indexOf(supplied)]),
            "recovery-prefix-cache-mismatch",
          );
          const allowed = new Set<number>(
            supplied.messages
              .filter((m: any[]) => !m[3].includes("held"))
              .map((m: any[]) => m[0]),
          );
          const targets = new Set<number>(supplied.targetIds ?? [...allowed]);
          const rangeScope = new Set<number>(
            supplied.targetIds ?? supplied.messages.map((m: any[]) => m[0]),
          );
          requireThat(
            block.candidates.every((c: Json) =>
              [...c.questionIds, ...c.responseIds].every((n) => allowed.has(n)),
            ) && block.contextIds.every((n: number) => targets.has(n)),
            "recovery-child-scope-mismatch",
          );
          for (const [start, end] of block.noncandidateRanges) {
            requireThat(start <= end, "recovery-child-scope-mismatch");
            for (let n = start; n <= end; n++)
              requireThat(rangeScope.has(n), "recovery-child-scope-mismatch");
          }
          accepted.push(block);
        }
        childEvidence.push({
          childHash,
          outputHash: digest(text),
          transportHash: digest(transportText),
          receiptHashes: witnesses.map(({ name }) =>
            files.get(join(receiptDirectory, name)),
          ),
        });
      }
      const recovery: { input: ContextRecoveryInput; raw: string }[] = [];
      if (accepted.length) {
        // Local bookkeeping completion only; this never changes the original prefix.
        const repaired = repairRelevantOutput(
          { packetId: id, complete: true, blocks: accepted },
          packet,
          batches,
          triage,
        );
        for (const block of accepted) {
          const historyCount = (
            db
              .prepare(
                "SELECT count(*) AS n FROM context_recoveries WHERE batch_id=?",
              )
              .get(block.batchId) as { n: number }
          ).n;
          if (historyCount) {
            skipped.push({
              batchId: block.batchId,
              reason: "existing-context-recovery",
              historyCount,
            });
            continue;
          }
          const supplied = source.blocks.find(
            (b: Json) => b.batchId === block.batchId,
          );
          const targets = supplied.messages
            .filter((m: any[]) => !m[3].includes("held"))
            .map((m: any[]) => m[0]);
          const batch = batches.find((b) => b.batchId === block.batchId)!;
          const canonical = repaired.prepared.find(
            (b) => b.batchId === block.batchId,
          )!;
          for (const input of inputs(store, block.batchId, targets)) {
            requireThat(
              input.blocks[0].targetIds.every((n) => targets.includes(n)),
              "recovery-target-mismatch",
            );
            recovery.push({ input, raw: project(input, canonical, batch) });
          }
        }
      }
      const memory = validationCopy(db, batchIds);
      try {
        const validator = facade(memory, directory);
        for (const item of recovery)
          validator.importContextRecovery(item.input, item.raw);
      } finally {
        memory.close();
      }
      const checkOriginals = () => {
        for (const row of before) {
          const current = db
            .prepare(
              "SELECT j.*,o.hash AS stored_hash,o.record AS stored_output,r.active FROM jobs j JOIN outputs o ON o.batch_id=j.id JOIN runs r ON r.id=j.run_id WHERE j.id=?",
            )
            .get(row.id);
          requireThat(same(current, row), "recovery-original-job-changed");
        }
      };
      const finish = () => {
        unchanged();
        checkOriginals();
        for (const history of historyBefore) {
          requireThat(
            same(
              db
                .prepare(
                  "SELECT * FROM context_recoveries WHERE batch_id=? ORDER BY rowid",
                )
                .all(history.batchId),
              history.rows,
            ),
            "recovery-history-changed",
          );
        }
        let imported = 0;
        if (options.apply)
          for (const item of recovery)
            imported += store.importContextRecovery(
              item.input,
              item.raw,
            ).imported;
        checkOriginals();
        const summary = {
          version: 1,
          packetId: id,
          apply: options.apply,
          modelCalls: 0,
          fullMeaningComplete: false,
          semanticReviewApproved: false,
          prefixBlocks: prefix.blocks.length,
          totalBlocks: source.blocks.length,
          cachedCandidates: accepted.reduce(
            (n, b) => n + b.candidates.length,
            0,
          ),
          preparedRecoveries: recovery.length,
          preparedCandidates: recovery.reduce(
            (n, r) => n + JSON.parse(r.raw).blocks[0].candidates.length,
            0,
          ),
          imported,
          skippedBatches: skipped.length,
        };
        // Private provenance contains hashes and counts only, never source text or keys.
        writeFileSync(
          resolve(options.out),
          JSON.stringify(
            {
              ...summary,
              databaseCommitConfirmed: false,
              evidenceStage: "validated-before-transaction-commit",
              childEvidence,
              skipped,
              files: [...files].map(([file, sha256]) => ({
                file: relative(directory, file),
                sha256,
              })),
              recoveries: recovery.map((r) => ({
                packetId: r.input.packetId,
                batchId: r.input.blocks[0].batchId,
                inputHash: digest(JSON.stringify(r.input)),
                outputHash: digest(r.raw),
                targets: r.input.blocks[0].targetIds.length,
              })),
            },
            null,
            2,
          ),
          { flag: "wx", mode: 0o600 },
        );
        return summary;
      };
      // File/receipt inspection runs without a long source-DB transaction.
      // Apply rechecks provenance/versions and appends atomically under one short lock.
      return options.apply ? db.transaction(finish).immediate() : finish();
    })();
  } finally {
    db.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(
      JSON.stringify(
        recoverCachedShards(parseRecoveryOptions(process.argv.slice(2))),
      ),
    );
  } catch {
    console.error(
      JSON.stringify({ error: "cached-shard-recovery-failed", modelCalls: 0 }),
    );
    process.exitCode = 1;
  }
}
