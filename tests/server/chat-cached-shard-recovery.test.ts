import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import childProcess from "node:child_process";
import {
  recoverCachedShards,
  parseRecoveryOptions,
  validationCopy,
} from "../../scripts/chat-cached-shard-recovery";
import { ChatJobStore } from "../../src/server/chat-pipeline/job-store";
import {
  hash,
  SANITIZER_VERSION,
} from "../../src/server/chat-pipeline/prepare";
import {
  candidateRelativeContext,
  codexPrompt,
  scopedOutputSchema,
} from "../../src/server/chat-pipeline/relative-context";
import {
  buildRelevant,
  prepareRequests,
  type Packet,
  type Triage,
} from "../../scripts/chat-jev-triage";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const digest = (raw: string | Buffer) =>
  createHash("sha256").update(raw).digest("hex");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const write = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value));
function fixture(settings: { heldInterior?: boolean; sparse?: boolean } = {}) {
  const maxMessages = settings.sparse ? 75 : 8;
  const root = mkdtempSync(join(tmpdir(), "cached-shard-synthetic-"));
  roots.push(root);
  const directory = join(root, "store"),
    store = new ChatJobStore(directory);
  store.prepare(
    [
      {
        id: "synthetic",
        bytes: new TextEncoder().encode(
          "연습방 카카오톡 대화\n--------------- 2026년 10월 2일 금요일 ---------------\n" +
            Array.from(
              { length: settings.sparse ? 223 : 20 },
              (_, i) =>
                `[가상발언자] [오전 ${(9 + Math.floor(i / 60)) % 12 || 12}:${String(i % 60).padStart(2, "0")}] ${settings.heldInterior && [3, maxMessages + 2].includes(i) ? "@합성미확인" : `합성 분석 자료 ${i}`}\n`,
            ).join(""),
        ),
      },
    ],
    {
      targetPrepared: true,
      scopeApproved: true,
      externalApproved: true,
      sampleReviewed: true,
      scopeVersion: "synthetic",
      reviewScopeVersion: "synthetic",
      reviewRuleVersion: SANITIZER_VERSION,
      externalVersion: "synthetic",
      maxMessages,
      overlap: 1,
    },
  );
  const batches = store.listBatches();
  expect(batches).toHaveLength(3);
  const blocks: Packet["blocks"] = batches.map((b) => ({
    batchId: b.batchId,
    inputHash: b.inputHash,
    messages: b.input.messages.map((m, i) => [
      i,
      m.speaker,
      m.text,
      m.held ? ["held"] : [],
    ]),
  }));
  const packet: Packet = {
    packetId: hash(blocks),
    instructions: "synthetic",
    blocks,
  };
  const triage: Triage = {
    packetId: packet.packetId,
    inputHash: hash(blocks),
    model: "jev-latest",
    complete: false,
    windows: prepareRequests(packet).windows.map((w) => ({
      ...w,
      label:
        settings.sparse && w.blockId === batches[0].batchId && w.start === 25
          ? "ordinary"
          : "candidate",
      confidence: 0.99,
      probability: 0.99,
      source: "jev",
      cause: w.blockId === batches[1].batchId ? "timeout" : "classified",
    })),
    requests: [],
    ordinaryUnread: true,
    lunaExaminedEntirePacket: false,
    dispositionSource: "jev",
  };
  const built = buildRelevant(packet, triage);
  for (const batch of batches)
    store.importResult(
      batch.batchId,
      JSON.stringify({
        batchId: batch.batchId,
        inputHash: batch.inputHash,
        complete: true,
        candidates: [],
        dispositions: batch.input.messages
          .filter((m) => !m.held)
          .map((m) => ({
            messageId: m.id,
            kind: "needs-context",
            reason: "합성 격리",
          })),
      }),
    );
  store.close();
  const native = join(directory, "native"),
    relevant = join(directory, "triage/relevant"),
    logs = join(directory, "codex-logs");
  for (const d of [native, relevant, logs, join(directory, "schemas")])
    mkdirSync(d, { recursive: true });
  const id = packet.packetId;
  write(join(native, `${id}.input.json`), packet);
  write(join(native, "manifest.json"), {
    packets: [{ packetId: id, batchIds: blocks.map((b) => b.batchId) }],
  });
  write(join(directory, "triage", `${id}.triage.json`), triage);
  write(join(relevant, "manifest.json"), {
    packets: [
      {
        packetId: id,
        originalBlockIds: blocks.map((b) => b.batchId),
        batchIds: built.packet.blocks.map((b) => b.batchId),
        mapping: built.mapping,
        triageComplete: built.triageComplete,
        lunaExaminedEntirePacket: false,
      },
    ],
  });
  const sourcePath = join(relevant, `${id}.input.json`);
  write(sourcePath, built.packet);
  const schemaPath = join(directory, "schemas/candidate.schema.json");
  writeFileSync(
    schemaPath,
    readFileSync(
      resolve("src/server/chat-pipeline/schemas/candidate.schema.json"),
    ),
  );
  const sourceText = readFileSync(sourcePath, "utf8"),
    schemaText = readFileSync(schemaPath, "utf8"),
    schema = JSON.parse(schemaText);
  const cache = join(
    directory,
    "candidate-shards",
    digest(JSON.stringify(["candidate-shards-v1", sourceText, schemaText, 2])),
  );
  mkdirSync(cache, { recursive: true });
  const child = { ...built.packet, blocks: built.packet.blocks.slice(0, 2) },
    childText = JSON.stringify(child),
    childHash = digest(childText);
  const childPath = (suffix: string) => join(cache, `${childHash}.${suffix}`);
  writeFileSync(childPath("input.json"), childText);
  const transport = {
      ...child,
      instructions: `${child.instructions}\nsynthetic additional transport instruction`,
    },
    transportText = JSON.stringify(transport);
  writeFileSync(childPath("transport.input.json"), transportText);
  const result = {
    packetId: id,
    complete: true,
    blocks: child.blocks.map((b) => ({
      batchId: b.batchId,
      candidates: [
        {
          localId: "q",
          title: "합성 질문",
          topic: "합성 분석",
          questionIds: [0],
          responseIds: [1],
          uncertainties: [],
          needsContext: false,
        },
        {
          localId: "u",
          title: "합성 미확인",
          topic: "합성 분석",
          questionIds: [6],
          responseIds: [7],
          uncertainties: ["합성 추가 문맥 필요"],
          needsContext: true,
        },
      ],
      noncandidateRanges: settings.heldInterior ? [[2, 4]] : [[2, 3]],
      contextIds: [5],
    })),
  };
  const resultText = JSON.stringify(result);
  writeFileSync(childPath("output.json"), resultText);
  writeFileSync(childPath("receipt.json"), digest(resultText));
  const prefixPath = join(relevant, `${id}.output.json`);
  write(prefixPath, { ...result, complete: false });
  const scopedText = JSON.stringify(
    scopedOutputSchema(schema, transport, "candidate"),
  );
  writeFileSync(join(logs, `${digest(scopedText)}.schema.json`), scopedText);
  const db = new Database(join(directory, "jobs.sqlite"), { readonly: true });
  const prompt = codexPrompt(
    transportText,
    candidateRelativeContext(db, transport),
  );
  db.close();
  const reservationId = "00000000-0000-4000-8000-000000000001",
    receiptPath = join(logs, `${reservationId}.receipt.json`);
  write(receiptPath, {
    reservationId,
    inputHash: digest(transportText),
    actualPromptHash: prompt.actualPromptHash,
    actualSchemaHash: digest(scopedText),
    actualSchemaBytes: Buffer.byteLength(scopedText),
    outputAccepted: true,
    settled: true,
    finalAccountConfirmed: true,
    exitCode: 0,
    stopped: false,
    attemptOutputExists: true,
    attemptOutputBytes: Buffer.byteLength(resultText),
  });
  const options = {
    packet: id,
    directory,
    blocksPerShard: 2,
    out: join(root, "result.private.json"),
    apply: false,
  };
  return {
    root,
    directory,
    batches,
    options,
    childPath,
    receiptPath,
    schemaPath,
    sourcePath,
    prefixPath,
    nativeManifest: join(native, "manifest.json"),
    relevantManifest: join(relevant, "manifest.json"),
    dbPath: join(directory, "jobs.sqlite"),
  };
}
function snapshot(f: ReturnType<typeof fixture>) {
  const db = new Database(f.dbPath, { readonly: true });
  try {
    return {
      original: JSON.stringify({
        jobs: db.prepare("SELECT * FROM jobs ORDER BY id").all(),
        outputs: db.prepare("SELECT * FROM outputs ORDER BY batch_id").all(),
      }),
      history: JSON.stringify(
        db.prepare("SELECT * FROM context_recoveries ORDER BY id").all(),
      ),
      count: (
        db.prepare("SELECT count(*) n FROM context_recoveries").get() as {
          n: number;
        }
      ).n,
    };
  } finally {
    db.close();
  }
}

function replaceCachedResult(f: ReturnType<typeof fixture>, result: any) {
  const raw = JSON.stringify(result);
  writeFileSync(f.childPath("output.json"), raw);
  writeFileSync(f.childPath("receipt.json"), digest(raw));
  const receipt = read(f.receiptPath);
  receipt.attemptOutputBytes = Buffer.byteLength(raw);
  write(f.receiptPath, receipt);
  write(f.prefixPath, { ...result, complete: false });
}

it("prepareChats overlap의 외부 활성 held를 최소 복사해 strict 입력을 보존한다", () => {
  const root = mkdtempSync(join(tmpdir(), "cached-overlap-synthetic-"));
  roots.push(root);
  const directory = join(root, "store"),
    store = new ChatJobStore(directory);
  store.prepare(
    [
      {
        id: "synthetic-overlap",
        bytes: new TextEncoder().encode(
          "연습방 카카오톡 대화\n--------------- 2026년 10월 2일 금요일 ---------------\n" +
            "[가] [오전 9:00] 첫 합성 문맥\n" +
            `[나] [오전 9:01] ${"가님은 ".repeat(600)}\n` +
            "[다] [오전 9:02] 끝 합성 문맥\n",
        ),
      },
    ],
    {
      targetPrepared: true,
      scopeApproved: true,
      externalApproved: true,
      sampleReviewed: true,
      scopeVersion: "synthetic",
      reviewScopeVersion: "synthetic",
      reviewRuleVersion: SANITIZER_VERSION,
      externalVersion: "synthetic",
      maxMessages: 2,
      overlap: 1,
      maxInputBytes: 16_000,
    },
  );
  const batches = store.listBatches();
  expect(batches).toHaveLength(2);
  expect(batches[0].input.messages.map((m) => m.held)).toEqual([false, false]);
  expect(batches[1].input.messages.map((m) => m.held)).toEqual([true, false]);
  expect(batches[0].input.messages[1].id).toBe(batches[1].input.messages[0].id);
  for (const batch of batches)
    store.importResult(
      batch.batchId,
      JSON.stringify({
        batchId: batch.batchId,
        inputHash: batch.inputHash,
        complete: true,
        candidates: [],
        dispositions: batch.input.messages
          .filter((m) => !m.held)
          .map((m) => ({
            messageId: m.id,
            kind: "needs-context",
            reason: "합성 격리",
          })),
      }),
    );
  store.close();
  const file = join(directory, "jobs.sqlite"),
    before = digest(readFileSync(file));
  const db = new Database(file, { readonly: true }),
    source = Object.assign(Object.create(ChatJobStore.prototype), {
      db,
      directory,
    });
  let memory: Database.Database | undefined;
  try {
    const selected = { batchId: batches[0].batchId, targetIds: [0] };
    const input = source.contextRecoveryInputs([], selected)[0];
    expect(input.blocks[0].messages.map((m: any[]) => m[0])).toEqual([0]);
    memory = validationCopy(db, [selected.batchId]);
    memory.pragma("foreign_keys = ON");
    expect(memory.pragma("foreign_key_check")).toEqual([]);
    expect(memory.prepare("SELECT count(*) n FROM jobs").get()).toEqual({
      n: 2,
    });
    expect(memory.prepare("SELECT count(*) n FROM outputs").get()).toEqual({
      n: 1,
    });
    const external = memory
      .prepare("SELECT * FROM coverage WHERE batch_id=?")
      .all(batches[1].batchId) as {
      batch_id: string;
      message_id: string;
      held: number;
    }[];
    expect(external).toEqual([
      {
        batch_id: batches[1].batchId,
        message_id: batches[0].input.messages[1].id,
        held: 1,
      },
    ]);
    const validator = Object.assign(Object.create(ChatJobStore.prototype), {
      db: memory,
      directory,
    });
    const raw = JSON.stringify({
      packetId: input.packetId,
      complete: true,
      blocks: [
        {
          batchId: selected.batchId,
          candidates: [],
          noncandidateRanges: [[0, 0]],
          contextIds: [],
        },
      ],
    });
    // 기존 사본처럼 외부 held를 누락하면 동일한 원본 입력을 과잉 거부한다.
    memory
      .prepare("DELETE FROM coverage WHERE batch_id=?")
      .run(batches[1].batchId);
    expect(
      validator
        .contextRecoveryInputs([], selected)[0]
        .blocks[0].messages.map((m: any[]) => m[0]),
    ).toEqual([0, 1]);
    expect(() => validator.importContextRecovery(input, raw)).toThrow(
      "invalid-context-recovery-input",
    );
    const row = external[0];
    memory
      .prepare("INSERT INTO coverage VALUES(?,?,?)")
      .run(row.batch_id, row.message_id, row.held);
    expect(validator.contextRecoveryInputs([], selected)[0]).toEqual(input);
    expect(validator.importContextRecovery(input, raw)).toMatchObject({
      imported: 0,
    });
    expect(source.contextRecoveryInputs([], selected)[0]).toEqual(input);
  } finally {
    memory?.close();
    db.close();
  }
  expect(digest(readFileSync(file))).toBe(before);
});

it("정상 범위의 held 내부는 허용하되 복구 target과 분류에서는 제외한다", () => {
  const f = fixture({ heldInterior: true }),
    before = snapshot(f);
  expect(f.batches.slice(0, 2).every((b) => b.input.messages[3].held)).toBe(
    true,
  );
  expect(recoverCachedShards(f.options)).toMatchObject({
    preparedRecoveries: 2,
    preparedCandidates: 4,
    imported: 0,
    modelCalls: 0,
  });
  expect(snapshot(f)).toEqual(before);
  expect(
    recoverCachedShards({
      ...f.options,
      apply: true,
      out: join(f.root, "held-apply.private.json"),
    }).imported,
  ).toBe(4);
  expect(snapshot(f).original).toBe(before.original);
  const db = new Database(f.dbPath, { readonly: true });
  const rows = db
    .prepare("SELECT batch_id,input,record FROM context_recoveries")
    .all() as { batch_id: string; input: string; record: string }[];
  db.close();
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    const batch = f.batches.find((b) => b.batchId === row.batch_id)!;
    const block = JSON.parse(row.input).blocks[0],
      output = JSON.parse(row.record).output;
    expect(block.targetIds).not.toContain(3);
    expect(block.messages.map((m: any[]) => m[0])).not.toContain(3);
    expect(output.dispositions.map((d: any) => d.messageId)).not.toContain(
      batch.input.messages[3].id,
    );
    expect(
      output.candidates.flatMap((c: any) => [
        ...c.questionIds,
        ...c.responseIds,
      ]),
    ).not.toContain(batch.input.messages[3].id);
  }
  const normal = JSON.parse(
    rows.find((r) => r.batch_id === f.batches[0].batchId)!.record,
  ).output;
  for (const n of [2, 4])
    expect(
      normal.dispositions.find(
        (d: any) => d.messageId === f.batches[0].input.messages[n].id,
      ).kind,
    ).toBe("noncandidate");
});

it.each(["start", "end", "candidate", "context"])(
  "held %s는 수입 전에 거부한다",
  (kind) => {
    const f = fixture({ heldInterior: true }),
      before = snapshot(f),
      result = read(f.childPath("output.json"));
    if (kind === "start") result.blocks[0].noncandidateRanges = [[3, 4]];
    else if (kind === "end") result.blocks[0].noncandidateRanges = [[2, 3]];
    else if (kind === "candidate")
      result.blocks[0].candidates[0].questionIds = [3];
    else result.blocks[0].contextIds = [3];
    replaceCachedResult(f, result);
    expect(() => recoverCachedShards({ ...f.options, apply: true })).toThrow();
    expect(snapshot(f)).toEqual(before);
    expect(existsSync(f.options.out)).toBe(false);
  },
);

it("양 끝이 제공되어도 내부에 누락 인덱스가 있는 범위는 거부한다", () => {
  const f = fixture({ sparse: true }),
    before = snapshot(f),
    result = read(f.childPath("output.json"));
  const supplied = read(f.childPath("input.json")).blocks[0].messages.map(
    (m: any[]) => m[0],
  );
  expect(supplied).toContain(29);
  expect(supplied).toContain(45);
  expect(supplied).not.toContain(30);
  result.blocks[0].noncandidateRanges = [[29, 45]];
  replaceCachedResult(f, result);
  expect(() => recoverCachedShards({ ...f.options, apply: true })).toThrow(
    "recovery-child-scope-mismatch",
  );
  expect(snapshot(f)).toEqual(before);
  expect(existsSync(f.options.out)).toBe(false);
});

it("dry-run validates canonical recovery without durable writes, permissions/PRAGMA changes or model calls", () => {
  const f = fixture(),
    before = snapshot(f),
    bytes = digest(readFileSync(f.dbPath)),
    mode = statSync(f.dbPath).mode;
  const spawn = vi.spyOn(childProcess, "spawn"),
    exec = vi.spyOn(childProcess, "execFile");
  const result = recoverCachedShards(f.options);
  expect(result).toMatchObject({
    prefixBlocks: 2,
    totalBlocks: 3,
    preparedRecoveries: 2,
    preparedCandidates: 4,
    imported: 0,
    modelCalls: 0,
    fullMeaningComplete: false,
  });
  expect(snapshot(f)).toEqual(before);
  expect(digest(readFileSync(f.dbPath))).toBe(bytes);
  expect(statSync(f.dbPath).mode).toBe(mode);
  expect(spawn).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
  const evidence = readFileSync(f.options.out, "utf8");
  expect(evidence).not.toContain("합성 질문");
  expect(evidence).not.toContain("합성 분석 자료");
});
it("appends good candidates/ranges, keeps missing and uncertain evidence and failed child pending, preserves originals, then adds zero on replay", () => {
  const f = fixture(),
    before = snapshot(f);
  const first = recoverCachedShards({ ...f.options, apply: true });
  expect(first.imported).toBe(4);
  expect(snapshot(f).original).toBe(before.original);
  const db = new Database(f.dbPath, { readonly: true });
  const rows = db
    .prepare("SELECT * FROM context_recoveries ORDER BY rowid")
    .all() as { batch_id: string; record: string; input: string }[];
  db.close();
  expect(rows).toHaveLength(2);
  expect(rows.some((r) => r.batch_id === f.batches[2].batchId)).toBe(false);
  const normal = JSON.parse(
    rows.find((r) => r.batch_id === f.batches[0].batchId)!.record,
  ).output;
  expect(normal.candidates[0].title).toBe("합성 질문");
  expect(normal.candidates[0].needsContext).toBe(false);
  expect(normal.candidates[1].needsContext).toBe(true);
  expect(
    normal.dispositions.find(
      (d: any) => d.messageId === f.batches[0].input.messages[2].id,
    ).kind,
  ).toBe("noncandidate");
  expect(
    normal.dispositions.find(
      (d: any) => d.messageId === f.batches[0].input.messages[4].id,
    ).kind,
  ).toBe("needs-context");
  const uncertain = JSON.parse(
    rows.find((r) => r.batch_id === f.batches[1].batchId)!.record,
  ).output;
  expect(
    uncertain.dispositions.find(
      (d: any) => d.messageId === f.batches[1].input.messages[2].id,
    ).kind,
  ).toBe("needs-context");
  const history = snapshot(f);
  expect(
    recoverCachedShards({
      ...f.options,
      apply: true,
      out: join(f.root, "replay.private.json"),
    }),
  ).toMatchObject({ imported: 0, preparedRecoveries: 0, skippedBatches: 2 });
  expect(snapshot(f)).toEqual(history);
});
it.each([
  "schema",
  "native-manifest",
  "relevant-manifest",
  "source",
  "cache-output",
  "local-receipt",
  "transport",
  "receipt-bytes",
  "receipt-input",
  "receipt-schema",
  "receipt-prompt",
  "failed-receipt",
  "unaccepted",
  "unconfirmed",
  "stopped",
  "exit",
  "wrong-uuid",
  "seed",
  "target",
  "prefix",
])("%s tamper fails closed with zero source writes", (kind) => {
  const f = fixture(),
    before = snapshot(f),
    bytes = digest(readFileSync(f.dbPath));
  if (kind === "schema")
    writeFileSync(f.schemaPath, readFileSync(f.schemaPath, "utf8") + " ");
  else if (kind === "native-manifest") {
    const x = read(f.nativeManifest);
    x.packets[0].batchIds.reverse();
    write(f.nativeManifest, x);
  } else if (kind === "relevant-manifest") {
    const x = read(f.relevantManifest);
    x.packets[0].mapping[0].keptOriginalIndexes = [];
    write(f.relevantManifest, x);
  } else if (kind === "source")
    writeFileSync(f.sourcePath, readFileSync(f.sourcePath, "utf8") + " ");
  else if (kind === "cache-output")
    writeFileSync(
      f.childPath("output.json"),
      readFileSync(f.childPath("output.json"), "utf8") + " ",
    );
  else if (kind === "local-receipt")
    writeFileSync(f.childPath("receipt.json"), "0".repeat(64));
  else if (kind === "transport") {
    const x = read(f.childPath("transport.input.json"));
    x.blocks[0].messages[0][0] = 999;
    write(f.childPath("transport.input.json"), x);
  } else if (kind === "seed") {
    const x = read(f.receiptPath);
    rmSync(f.receiptPath);
    write(join(f.directory, "codex-logs", "seed.receipt.json"), x);
  } else if (kind === "target") {
    const proto = ChatJobStore.prototype as any,
      original = proto.contextRecoveryInputs;
    vi.spyOn(proto, "contextRecoveryInputs").mockImplementation(function (
      this: any,
      ...args: any[]
    ) {
      const result = original.apply(this, args);
      if (result.length) result[0].blocks[0].targetIds.push(999);
      return result;
    });
  } else if (kind === "prefix") {
    const x = read(f.prefixPath);
    x.complete = true;
    write(f.prefixPath, x);
  } else {
    const x = read(f.receiptPath);
    if (kind === "receipt-bytes") x.attemptOutputBytes++;
    if (kind === "receipt-input") x.inputHash = "0".repeat(64);
    if (kind === "receipt-schema") x.actualSchemaHash = "0".repeat(64);
    if (kind === "receipt-prompt") x.actualPromptHash = "0".repeat(64);
    if (kind === "failed-receipt") x.settled = false;
    if (kind === "unaccepted") x.outputAccepted = false;
    if (kind === "unconfirmed") x.finalAccountConfirmed = false;
    if (kind === "stopped") x.stopped = true;
    if (kind === "exit") x.exitCode = 1;
    if (kind === "wrong-uuid") x.reservationId = "unknown";
    write(f.receiptPath, x);
  }
  expect(() => recoverCachedShards({ ...f.options, apply: true })).toThrow();
  expect(snapshot(f)).toEqual(before);
  expect(digest(readFileSync(f.dbPath))).toBe(bytes);
  expect(existsSync(f.options.out)).toBe(false);
});
it("skips a prior successful recovery without changing any prior history bytes", () => {
  const f = fixture(),
    store = new ChatJobStore(f.directory);
  const input = (store as any).contextRecoveryInputs([], {
    batchId: f.batches[0].batchId,
    targetIds: [5],
  })[0];
  store.importContextRecovery(
    input,
    JSON.stringify({
      packetId: input.packetId,
      complete: true,
      blocks: [
        {
          batchId: f.batches[0].batchId,
          candidates: [],
          noncandidateRanges: [[5, 5]],
          contextIds: [],
        },
      ],
    }),
  );
  store.close();
  const before = snapshot(f);
  const result = recoverCachedShards({ ...f.options, apply: true });
  expect(result).toMatchObject({
    skippedBatches: 1,
    preparedRecoveries: 1,
    imported: 2,
  });
  expect(snapshot(f).original).toBe(before.original);
  const db = new Database(f.dbPath, { readonly: true });
  const previous = db
    .prepare("SELECT * FROM context_recoveries WHERE batch_id=? ORDER BY id")
    .all(f.batches[0].batchId);
  db.close();
  expect(JSON.stringify(previous)).toBe(before.history);
  expect(read(f.options.out).skipped[0].reason).toBe(
    "existing-context-recovery",
  );
});
it("strict import rejects changed input context in the in-memory preflight before durable append", () => {
  const f = fixture(),
    before = snapshot(f),
    proto = ChatJobStore.prototype as any,
    original = proto.contextRecoveryInputs;
  let calls = 0;
  vi.spyOn(proto, "contextRecoveryInputs").mockImplementation(function (
    this: any,
    ...args: any[]
  ) {
    const result = original.apply(this, args);
    if (++calls <= 2 && result.length)
      result[0].blocks[0].messages[0][2] = "변조된 합성 문맥";
    return result;
  });
  expect(() => recoverCachedShards({ ...f.options, apply: true })).toThrow(
    "invalid-context-recovery-input",
  );
  expect(snapshot(f)).toEqual(before);
  expect(existsSync(f.options.out)).toBe(false);
});
it("requires private exclusive evidence and explicit apply", () => {
  const f = fixture();
  expect(
    parseRecoveryOptions(["--packet", f.options.packet, "--out", f.options.out])
      .apply,
  ).toBe(false);
  expect(() => parseRecoveryOptions(["--packet", f.options.packet])).toThrow(
    "private-recovery-out-required",
  );
  write(f.options.out, { immutable: true });
  expect(() => recoverCachedShards({ ...f.options, apply: true })).toThrow(
    "recovery-artifact-exists",
  );
  expect(snapshot(f).count).toBe(0);
});
it("does not accept a rejected output or an unverified full incomplete parent as a cached prefix", () => {
  const f = fixture(),
    before = snapshot(f);
  write(f.childPath("rejected.json"), read(f.childPath("output.json")));
  rmSync(f.childPath("output.json"));
  expect(() => recoverCachedShards({ ...f.options, apply: true })).toThrow();
  expect(snapshot(f)).toEqual(before);
  const prefix = read(f.prefixPath);
  prefix.blocks.push({
    batchId: f.batches[2].batchId,
    candidates: [],
    noncandidateRanges: [],
    contextIds: [],
  });
  write(f.prefixPath, prefix);
  expect(() => recoverCachedShards({ ...f.options, apply: true })).toThrow(
    "recovery-parent-not-quarantine-prefix",
  );
  expect(snapshot(f)).toEqual(before);
});
it("revalidates numeric scope even when output bytes/local receipt are self-consistent", () => {
  const f = fixture(),
    before = snapshot(f),
    result = read(f.childPath("output.json"));
  result.blocks[0].candidates[0].questionIds = [999];
  const raw = JSON.stringify(result);
  writeFileSync(f.childPath("output.json"), raw);
  writeFileSync(f.childPath("receipt.json"), digest(raw));
  const call = read(f.receiptPath);
  call.attemptOutputBytes = Buffer.byteLength(raw);
  write(f.receiptPath, call);
  write(f.prefixPath, { ...result, complete: false });
  expect(() => recoverCachedShards({ ...f.options, apply: true })).toThrow();
  expect(snapshot(f)).toEqual(before);
});
it("executes the CLI with default dry-run and reports a safe nonzero failure without exposing content", () => {
  const f = fixture(),
    before = snapshot(f);
  const args = [
    "--import",
    "tsx",
    resolve("scripts/chat-cached-shard-recovery.ts"),
    "--packet",
    f.options.packet,
    "--directory",
    f.directory,
    "--out",
    f.options.out,
  ];
  const result = childProcess.spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    apply: false,
    modelCalls: 0,
    imported: 0,
    preparedRecoveries: 2,
  });
  expect(snapshot(f)).toEqual(before);
  const failure = childProcess.spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  expect(failure.status).toBe(1);
  expect(failure.stdout).toBe("");
  expect(JSON.parse(failure.stderr)).toEqual({
    error: "cached-shard-recovery-failed",
    modelCalls: 0,
  });
  expect(snapshot(f)).toEqual(before);
});
