import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
  ChatJobStore,
  contextRecoveryDigest,
  type ContextRecoveryInput,
} from "../../src/server/chat-pipeline/job-store";
import {
  SANITIZER_VERSION,
  type PrepareOptions,
  type BatchCandidate,
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
const ready: PrepareOptions = {
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
};
function fixture(
  options: PrepareOptions = ready,
  bodies = [
    "첫 문맥",
    "두 번째 문맥",
    "분석 질문",
    "추가 설명",
    "응답 자료",
    "인사",
    "끝 문맥",
  ],
) {
  const root = mkdtempSync(join(tmpdir(), "chat-context-recovery-synthetic-"));
  roots.push(root);
  const store = new ChatJobStore(join(root, "store"));
  stores.push(store);
  const source = {
    id: "synthetic-only",
    bytes: new TextEncoder().encode(
      "연습방 카카오톡 대화\n--------------- 2026년 10월 2일 금요일 ---------------\n" +
        bodies
          .map(
            (b, i) =>
              `[가상발언자] [오전 9:${String(i).padStart(2, "0")}] ${b}\n`,
          )
          .join(""),
    ),
  };
  store.prepare([source], options);
  const batches = store.listBatches();
  return { root, store, source, batches, batch: batches[0] };
}
function complete(
  f: ReturnType<typeof fixture>,
  targetIndexes = [3],
  candidates: BatchCandidate[] = [],
) {
  for (const batch of f.batches) {
    const evidence = new Set(
      candidates.flatMap((c) => [...c.questionIds, ...c.responseIds]),
    );
    f.store.importResult(
      batch.batchId,
      JSON.stringify({
        batchId: batch.batchId,
        inputHash: batch.inputHash,
        complete: true,
        candidates,
        dispositions: batch.input.messages.flatMap((m, i) =>
          m.held || evidence.has(m.id)
            ? []
            : [
                {
                  messageId: m.id,
                  kind: targetIndexes.includes(i)
                    ? "needs-context"
                    : "noncandidate",
                  reason: "합성 분류",
                },
              ],
        ),
      }),
    );
  }
}
function output(
  input: ContextRecoveryInput,
  changes: Record<string, unknown> = {},
) {
  return JSON.stringify({
    packetId: input.packetId,
    complete: true,
    blocks: [
      {
        batchId: input.blocks[0].batchId,
        candidates: [],
        noncandidateRanges: [],
        contextIds: [],
        ...changes,
      },
    ],
  });
}
function snapshot(f: ReturnType<typeof fixture>) {
  const db = new Database(join(f.store.directory, "jobs.sqlite"), {
    readonly: true,
  });
  try {
    return JSON.stringify(
      ["runs", "jobs", "outputs", "candidate_links"].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
    );
  } finally {
    db.close();
  }
}

it("completed ready의 비보류 대상과 같은 배치 앞뒤 2개만 제공한다", () => {
  const f = fixture();
  expect(f.store.listContextRecoveryInputs()).toEqual([]);
  complete(f);
  const [input] = f.store.listContextRecoveryInputs();
  expect(input.blocks[0].targetIds).toEqual([3]);
  expect(input.blocks[0].messages.map((m) => m[0])).toEqual([1, 2, 3, 4, 5]);
  expect(JSON.stringify(input)).not.toContain("가상발언자");
  expect(JSON.stringify(input)).not.toContain("occurrence");
  expect(f.store.listContextRecoveryInputs()).toEqual([input]);
  const local = fixture({ ...ready, scopeApproved: false });
  complete(local);
  expect(local.store.listContextRecoveryInputs()).toEqual([]);
});

it("held를 대상·주변 문맥·후보 근거 모두에서 제외한다", () => {
  const f = fixture(ready, [
    "첫 문맥",
    "분석 질문",
    "집주소는 특정주소",
    "분석 응답",
    "끝 문맥",
  ]);
  expect(f.batch.input.messages[2].held).toBe(true);
  complete(f, [1, 2]);
  const [input] = f.store.listContextRecoveryInputs();
  expect(input.blocks[0].targetIds).toEqual([1]);
  expect(input.blocks[0].messages.map((m) => m[0])).not.toContain(2);
  expect(() =>
    f.store.importContextRecovery(
      input,
      output(input, {
        candidates: [
          {
            localId: "held",
            title: "합성 분석",
            topic: "기술",
            questionIds: [1],
            responseIds: [2],
            uncertainties: [],
            needsContext: false,
          },
        ],
      }),
    ),
  ).toThrow("out-of-scope");
  expect(f.store.summary().messageDispositions.held).toBe(1);
});

it("실제 모델 noncandidate만 누적하며 원본을 보존하고 정확한 바이트 해시를 저장한다", () => {
  const f = fixture();
  complete(f);
  const before = snapshot(f),
    [input] = f.store.listContextRecoveryInputs();
  const raw = output(input, { noncandidateRanges: [[3, 3]] });
  expect(f.store.importContextRecovery(input, raw)).toMatchObject({
    replay: false,
    imported: 0,
  });
  expect(snapshot(f)).toBe(before);
  expect(f.store.summary().messageDispositions).toMatchObject({
    needsContext: 0,
    noncandidate: 7,
    pending: 0,
  });
  expect(f.store.listContextRecoveryInputs()).toEqual([]);
  const db = new Database(join(f.store.directory, "jobs.sqlite"), {
    readonly: true,
  });
  try {
    expect(
      db
        .prepare(
          "SELECT input_hash,output_hash,raw_output FROM context_recoveries",
        )
        .get(),
    ).toEqual({
      input_hash: contextRecoveryDigest(JSON.stringify(input)),
      output_hash: contextRecoveryDigest(raw),
      raw_output: raw,
    });
  } finally {
    db.close();
  }
  expect(f.store.importContextRecovery(input, raw)).toMatchObject({
    replay: true,
  });
  expect(() =>
    f.store.importContextRecovery(input, output(input, { contextIds: [3] })),
  ).toThrow("conflicting-context-recovery-output");
});

it("누락 recovery는 ordinary로 만들지 않고 다음 복구 입력으로 남긴다", () => {
  const f = fixture();
  complete(f);
  const [input] = f.store.listContextRecoveryInputs();
  f.store.importContextRecovery(input, output(input));
  expect(f.store.summary().messageDispositions).toMatchObject({
    needsContext: 1,
    noncandidate: 6,
    pending: 0,
  });
  const [next] = f.store.listContextRecoveryInputs();
  expect(next.packetId).not.toBe(input.packetId);
  expect(next.blocks[0].previousRecoveryIds).toEqual([input.packetId]);
  f.store.importContextRecovery(
    next,
    output(next, { noncandidateRanges: [[3, 3]] }),
  );
  expect(f.store.summary().messageDispositions.needsContext).toBe(0);
  expect(f.store.importContextRecovery(input, output(input))).toMatchObject({
    replay: true,
  });
});

it("같은 미해결 분류의 중복 표시는 기록하며 후보와 대상 모두 미해결로 유지한다", () => {
  const f = fixture();
  complete(f);
  const [input] = f.store.listContextRecoveryInputs(),
    before = snapshot(f);
  const raw = output(input, {
    candidates: [
      {
        localId: "unresolved",
        title: "추가 문맥이 필요한 분석",
        topic: "분석",
        questionIds: [3],
        responseIds: [],
        uncertainties: ["주변 응답 불명"],
        needsContext: true,
      },
    ],
    contextIds: [3],
  });
  expect(f.store.importContextRecovery(input, raw).imported).toBe(1);
  expect(snapshot(f)).toBe(before);
  expect(f.store.summary().messageDispositions.needsContext).toBe(1);
  expect(f.store.listContextRecoveryInputs()).toHaveLength(1);
  const db = new Database(join(f.store.directory, "jobs.sqlite"), {
    readonly: true,
  });
  try {
    const row = db
      .prepare("SELECT raw_output,record FROM context_recoveries")
      .get() as { raw_output: string; record: string };
    expect(row.raw_output).toBe(raw);
    expect(JSON.parse(row.record).redundantUnresolvedIds).toEqual([
      f.batch.input.messages[3].id,
    ]);
    expect(JSON.parse(row.record).output.candidates[0].needsContext).toBe(true);
  } finally {
    db.close();
  }
});

it.each(["resolved", "noncandidate", "duplicate-context"])(
  "미해결과 %s 분류의 충돌은 거부한다",
  (kind) => {
    const f = fixture();
    complete(f);
    const [input] = f.store.listContextRecoveryInputs();
    const candidate = {
      localId: "c",
      title: "합성 분석",
      topic: "분석",
      questionIds: [3],
      responseIds: [],
      uncertainties: [],
      needsContext: kind !== "resolved",
    };
    const raw = output(input, {
      candidates: [candidate],
      contextIds:
        kind === "duplicate-context" ? [3, 3] : kind === "resolved" ? [3] : [],
      noncandidateRanges: kind === "noncandidate" ? [[3, 3]] : [],
    });
    expect(() => f.store.importContextRecovery(input, raw)).toThrow();
    expect(f.store.summary().messageDispositions.needsContext).toBe(1);
  },
);

it("주변 문맥에만 있는 미해결 관찰은 비공개로 보존하고 후보로 가져오지 않는다", () => {
  const f = fixture();
  complete(f);
  const [input] = f.store.listContextRecoveryInputs();
  const raw = output(input, {
    candidates: [
      {
        localId: "neighbor",
        title: "주변 문맥의 질문",
        topic: "분석",
        questionIds: [1],
        responseIds: [],
        uncertainties: [],
        needsContext: true,
      },
    ],
  });
  expect(f.store.importContextRecovery(input, raw).imported).toBe(0);
  expect(f.store.listCandidates()).toHaveLength(0);
  expect(f.store.summary().messageDispositions).toMatchObject({
    needsContext: 1,
    noncandidate: 6,
  });
  const db = new Database(join(f.store.directory, "jobs.sqlite"), {
    readonly: true,
  });
  try {
    const row = db
      .prepare("SELECT raw_output,record FROM context_recoveries")
      .get() as { raw_output: string; record: string };
    expect(row.raw_output).toBe(raw);
    expect(JSON.parse(row.record).deferredContextCandidates).toHaveLength(1);
    expect(JSON.parse(row.record).output.candidates).toHaveLength(0);
  } finally {
    db.close();
  }
});

it.each(["resolved", "outside", "invalid-metadata"])(
  "주변 관찰의 %s 결과로 대상 검증을 우회할 수 없다",
  (kind) => {
    const f = fixture();
    complete(f);
    const [input] = f.store.listContextRecoveryInputs();
    const raw = output(input, {
      candidates: [
        {
          localId: "neighbor",
          title: kind === "invalid-metadata" ? "" : "합성 분석",
          topic: "분석",
          questionIds: [kind === "outside" ? 0 : 1],
          responseIds: [],
          uncertainties: [],
          needsContext: kind !== "resolved",
        },
      ],
    });
    expect(() => f.store.importContextRecovery(input, raw)).toThrow();
    expect(f.store.summary().messageDispositions.needsContext).toBe(1);
  },
);

it("unknown/API 오류/불완전 결과는 저장하지 않고 unresolved를 유지한다", () => {
  const f = fixture();
  complete(f);
  const [input] = f.store.listContextRecoveryInputs();
  for (const raw of [
    "not-json",
    JSON.stringify({ error: "api-failed" }),
    output(input).replace('"complete":true', '"complete":false'),
    output(input, { contextIds: [3], unknown: true }),
  ])
    expect(() => f.store.importContextRecovery(input, raw)).toThrow();
  expect(f.store.summary().messageDispositions.needsContext).toBe(1);
  expect(f.store.listContextRecoveryInputs()).toEqual([input]);
});

it("범위 밖·주변 ordinary 재분류·중복·위조된 입력과 unrelated 후보를 거부한다", () => {
  const f = fixture();
  complete(f);
  const [input] = f.store.listContextRecoveryInputs();
  const candidate = {
    localId: "recovered",
    title: "합성 분석",
    topic: "기술",
    questionIds: [3],
    responseIds: [6],
    uncertainties: [],
    needsContext: false,
  };
  for (const changes of [
    { candidates: [candidate] },
    { noncandidateRanges: [[2, 3]] },
    { contextIds: [3, 3] },
    { candidates: [{ ...candidate, questionIds: [2], responseIds: [] }] },
    { candidates: [{ ...candidate, responseIds: [] }], contextIds: [3] },
  ])
    expect(() =>
      f.store.importContextRecovery(input, output(input, changes)),
    ).toThrow();
  const tampered = structuredClone(input);
  tampered.blocks[0].messages[0][2] = "위조 문맥";
  expect(() => f.store.importContextRecovery(tampered, output(input))).toThrow(
    "invalid-context-recovery-input",
  );
  expect(f.store.summary().messageDispositions.needsContext).toBe(1);
});

it("활성 run이 바뀌면 새 import와 기존 replay 모두 거부한다", () => {
  const f = fixture();
  complete(f);
  const [input] = f.store.listContextRecoveryInputs(),
    raw = output(input, { contextIds: [3] });
  f.store.importContextRecovery(input, raw);
  f.store.prepare([f.source], { ...ready, promptVersion: "changed-version" });
  expect(() => f.store.importContextRecovery(input, raw)).toThrow(
    "stale-context-recovery-source",
  );
  expect(() =>
    f.store.importContextRecovery({ ...input, packetId: "f".repeat(64) }, raw),
  ).toThrow("stale-context-recovery-source");
});

it("질문 근거 overlap으로 기존 후보에 통합하고 editorial에서 쓰는 listCandidates에 응답을 추가한다", () => {
  const f = fixture();
  const candidate: BatchCandidate = {
    localId: "original",
    title: "메모리 분석",
    topic: "기술",
    questionIds: [f.batch.input.messages[2].id],
    responseIds: [],
    uncertainties: [],
    needsContext: false,
  };
  complete(f, [3], [candidate]);
  const original = f.store.listCandidates()[0],
    before = snapshot(f),
    [input] = f.store.listContextRecoveryInputs();
  f.store.importContextRecovery(
    input,
    output(input, {
      candidates: [
        {
          ...candidate,
          localId: "supplemental",
          questionIds: [2],
          responseIds: [3],
        },
      ],
    }),
  );
  expect(snapshot(f)).toBe(before);
  expect(f.store.listCandidates()).toHaveLength(1);
  expect(f.store.listCandidates()[0]).toMatchObject({
    candidateKey: original.candidateKey,
    responseIds: [f.batch.input.messages[3].id],
  });
  expect(f.store.summary()).toMatchObject({
    candidates: 1,
    candidateQuestionMessages: 1,
    messageDispositions: { candidate: 2, needsContext: 0, noncandidate: 5 },
  });
});

it("새 후보의 질문 수와 unresolved를 중복 없이 집계한다", () => {
  const f = fixture();
  complete(f, [2, 3]);
  const [input] = f.store.listContextRecoveryInputs();
  const raw = output(input, {
    candidates: [
      {
        localId: "new",
        title: "합성 분석",
        topic: "기술",
        questionIds: [2],
        responseIds: [3],
        uncertainties: [],
        needsContext: true,
      },
    ],
  });
  f.store.importContextRecovery(input, raw);
  f.store.importContextRecovery(input, raw);
  expect(f.store.summary()).toMatchObject({
    candidates: 1,
    candidateQuestionMessages: 1,
    pendingMessages: 0,
    messageDispositions: { candidate: 0, needsContext: 2 },
  });
});

it("CLI prepare/import가 크기 제한·manifest 검증·재실행을 지키며 모델 실행 없이 동작한다", () => {
  const f = fixture();
  complete(f);
  const directory = join(f.root, "recovery");
  const launch = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/chat-context-recovery.ts",
        ...args,
        "--store",
        f.store.directory,
        "--directory",
        directory,
      ],
      { encoding: "utf8" },
    );
  const first = launch("prepare");
  expect(first.status, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({
    packets: 1,
    privateOnly: true,
    executedModels: 0,
  });
  expect(launch("prepare").status).toBe(0);
  for (const file of readdirSync(directory))
    expect(statSync(join(directory, file)).size).toBeLessThanOrEqual(500_000);
  const [input] = f.store.listContextRecoveryInputs(),
    file = join(f.root, "actual.output.json");
  writeFileSync(file, output(input));
  expect(launch("import", file).status).toBe(0);
  expect(launch("import", file).status).toBe(0);
  expect(launch("prepare").status).toBe(0);
  const [next] = f.store.listContextRecoveryInputs();
  writeFileSync(file, output(next, { noncandidateRanges: [[3, 3]] }));
  expect(launch("import", file).status).toBe(0);
  expect(f.store.summary().messageDispositions.needsContext).toBe(0);
  const inputFile = join(directory, `${input.packetId}.input.json`);
  writeFileSync(inputFile, readFileSync(inputFile, "utf8") + " ");
  writeFileSync(file, output(input));
  expect(() => importContextRecoveryOutput(f.store, directory, file)).toThrow(
    "input-hash-mismatch",
  );
}, 30_000);

it("prepare의 안정 해시와 private manifest를 유지한다", () => {
  const f = fixture();
  complete(f);
  const directory = join(f.root, "prepared");
  expect(prepareContextRecovery(f.store, directory)).toEqual(
    prepareContextRecovery(f.store, directory),
  );
  if (process.platform !== "win32")
    for (const file of readdirSync(directory))
      expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
});

it("겹친 배치의 수입 메시지를 한 번 집계하고 미완료 overlap이 문맥 보류를 숨기지 않는다", () => {
  const f = fixture({ ...ready, maxMessages: 4, overlap: 2 });
  const first = f.batches[0];
  f.store.importResult(
    first.batchId,
    JSON.stringify({
      batchId: first.batchId,
      inputHash: first.inputHash,
      complete: true,
      candidates: [],
      dispositions: first.input.messages.map((m, i) => ({
        messageId: m.id,
        kind: i === 3 ? "needs-context" : "noncandidate",
        reason: "합성 분류",
      })),
    }),
  );
  expect(f.store.summary()).toMatchObject({
    importedCoveredMessages: 4,
    unimportedCoveredMessages: 3,
    needsContextMessages: 1,
    semanticReviewRequiredMessages: 1,
    messageDispositions: { pending: 3, needsContext: 1, noncandidate: 3 },
  });
  const [input] = f.store.listContextRecoveryInputs();
  f.store.importContextRecovery(
    input,
    output(input, { noncandidateRanges: [[3, 3]] }),
  );
  expect(f.store.summary()).toMatchObject({
    importedCoveredMessages: 4,
    unimportedCoveredMessages: 3,
    pendingMessages: 3,
    semanticReviewRequiredMessages: 0,
    messageDispositions: { pending: 3, needsContext: 0, noncandidate: 4 },
  });
  // A completed overlapping batch may still carry the old context conclusion.
  for (const batch of f.batches.slice(1))
    f.store.importResult(
      batch.batchId,
      JSON.stringify({
        batchId: batch.batchId,
        inputHash: batch.inputHash,
        complete: true,
        candidates: [],
        dispositions: batch.input.messages.map((m) => ({
          messageId: m.id,
          kind:
            m.id === first.input.messages[3].id
              ? "needs-context"
              : "noncandidate",
          reason: "합성 분류",
        })),
      }),
    );
  expect(f.store.summary().messageDispositions).toMatchObject({
    pending: 0,
    needsContext: 0,
    noncandidate: 7,
  });
  expect(f.store.listContextRecoveryInputs()).toEqual([]);
});

it("500k보다 큰 원본 배치의 recovery를 분할하고 준비된 모든 조각을 순서대로 import한다", () => {
  const f = fixture(
    { ...ready, maxInputBytes: 2_000_000 },
    Array.from(
      { length: 10 },
      (_, i) => `메모리 분석 ${i} ` + "DATA ".repeat(14_000),
    ),
  );
  expect(f.batches).toHaveLength(1);
  complete(
    f,
    Array.from({ length: 10 }, (_, i) => i),
  );
  const inputs = f.store.listContextRecoveryInputs();
  expect(inputs.length).toBeGreaterThan(1);
  expect(inputs.flatMap((p) => p.blocks[0].targetIds)).toEqual(
    Array.from({ length: 10 }, (_, i) => i),
  );
  for (const input of inputs) {
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(
      500_000,
    );
    f.store.importContextRecovery(
      input,
      output(input, {
        noncandidateRanges: input.blocks[0].targetIds.map((i) => [i, i]),
      }),
    );
  }
  expect(f.store.summary().messageDispositions).toMatchObject({
    needsContext: 0,
    pending: 0,
    noncandidate: 10,
  });
}, 15_000);

it("다른 배치에서 복구된 동일 근거가 있어도 이미 준비한 packet의 범위를 검증해 수입한다", () => {
  const f = fixture({ ...ready, maxMessages: 4, overlap: 2 });
  complete(f, [0, 1, 2, 3]);
  const inputs = f.store.listContextRecoveryInputs();
  expect(inputs).toHaveLength(3);
  for (const input of inputs)
    f.store.importContextRecovery(
      input,
      output(input, {
        noncandidateRanges: input.blocks[0].targetIds.map((i) => [i, i]),
      }),
    );
  expect(f.store.summary().messageDispositions).toMatchObject({
    needsContext: 0,
    noncandidate: 7,
  });
});

it("완전한 target 복구는 원본을 보존하면서 후보의 문맥 보류를 해제한다", () => {
  const f = fixture();
  const original: BatchCandidate = {
    localId: "repaired",
    title: "부분 분석",
    topic: "기술",
    questionIds: [f.batch.input.messages[2].id],
    responseIds: [f.batch.input.messages[3].id],
    uncertainties: ["원문 관계 확인 필요"],
    needsContext: true,
  };
  complete(f, [], [original]);
  const before = snapshot(f),
    candidateKey = f.store.listCandidates()[0].candidateKey,
    [input] = f.store.listContextRecoveryInputs();
  const editorialRoot = join(f.root, "editorial-flow"),
    editorialDirectory = join(editorialRoot, "data", "chat-pipeline");
  mkdirSync(editorialDirectory, { recursive: true });
  const selected = join(editorialRoot, "candidate-keys.json");
  writeFileSync(selected, JSON.stringify([candidateKey]));
  const prepareEditorial = () => {
    // Copy only the synthetic fixture, keeping CLI preparation isolated from
    // the source store. No model call or publication occurs in this test.
    copyFileSync(
      join(f.store.directory, "jobs.sqlite"),
      join(editorialDirectory, "jobs.sqlite"),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        resolve("scripts/chat-editorial-batches.ts"),
        "prepare",
        "--candidate-keys",
        selected,
      ],
      { cwd: editorialRoot, encoding: "utf8", timeout: 20_000 },
    );
    expect(result.status).toBe(0);
    return JSON.parse(
      readFileSync(
        join(editorialDirectory, "editorial-batches", "manifest.json"),
        "utf8",
      ),
    );
  };
  const pending = prepareEditorial();
  expect(pending.packets).toEqual([]);
  expect(pending.deferredCandidateKeys).toEqual([candidateKey]);
  expect(f.store.summary().messageDispositions.needsContext).toBe(2);
  expect(input.blocks[0].targetIds).toEqual([2, 3]);
  const raw = output(input, {
    candidates: [
      {
        ...original,
        localId: "supplement",
        title: "복구한 메모리 분석",
        topic: "복구한 기술",
        questionIds: [2],
        responseIds: [3, 4],
        uncertainties: [],
        needsContext: false,
      },
    ],
  });
  f.store.importContextRecovery(input, raw);
  expect(snapshot(f)).toBe(before);
  expect(f.store.listCandidates()).toHaveLength(1);
  expect(f.store.listCandidates()[0]).toMatchObject({
    candidateKey,
    localId: "repaired",
    title: "복구한 메모리 분석",
    topic: "복구한 기술",
    uncertainties: [],
    needsContext: false,
    sourceBatchIds: [f.batch.batchId],
    responseIds: [
      f.batch.input.messages[3].id,
      f.batch.input.messages[4].id,
    ].sort(),
  });
  expect(f.store.listContextRecoveryInputs()).toEqual([]);
  expect(f.store.summary().messageDispositions.needsContext).toBe(0);
  const ready = prepareEditorial();
  expect(ready.deferredCandidateKeys).toEqual([]);
  expect(ready.packets).toHaveLength(1);
  const prepared = JSON.parse(readFileSync(ready.packets[0].input, "utf8"));
  expect(prepared.entries).toHaveLength(1);
  expect(prepared.entries[0]).toMatchObject({
    candidateKey,
    needsContext: false,
    title: "복구한 메모리 분석",
  });
  expect(prepared.entries[0].evidence.map((e: { id: string }) => e.id)).toEqual(
    [
      f.batch.input.messages[2].id,
      f.batch.input.messages[3].id,
      f.batch.input.messages[4].id,
    ],
  );
});

it("needsContext 후보의 재검토가 누락되거나 여전히 불확실하면 다시 대상에 남긴다", () => {
  const f = fixture();
  const original: BatchCandidate = {
    localId: "unresolved",
    title: "부분 분석",
    topic: "기술",
    questionIds: [f.batch.input.messages[2].id],
    responseIds: [f.batch.input.messages[3].id],
    uncertainties: [],
    needsContext: true,
  };
  complete(f, [], [original]);
  const [input] = f.store.listContextRecoveryInputs();
  f.store.importContextRecovery(input, output(input));
  expect(f.store.listCandidates()[0].needsContext).toBe(true);
  expect(f.store.summary().messageDispositions.needsContext).toBe(2);
  const [next] = f.store.listContextRecoveryInputs();
  expect(next.blocks[0].targetIds).toEqual([2, 3]);
  f.store.importContextRecovery(
    next,
    output(next, {
      candidates: [{ ...original, questionIds: [2], responseIds: [3] }],
    }),
  );
  expect(f.store.listContextRecoveryInputs()[0].blocks[0].targetIds).toEqual([
    2, 3,
  ]);
  expect(f.store.summary().messageDispositions.needsContext).toBe(2);
  expect(f.store.listCandidates()[0].needsContext).toBe(true);
});

it.each(["missing", "noncandidate", "role-change", "unresolved"])(
  "부분 또는 불확실한 복구는 원래 후보를 계속 보류한다: %s",
  (kind) => {
    const f = fixture();
    const original: BatchCandidate = {
      localId: "original",
      title: "부분 분석",
      topic: "기술",
      questionIds: [f.batch.input.messages[2].id],
      responseIds: [f.batch.input.messages[3].id],
      uncertainties: ["응답 관계 확인 필요"],
      needsContext: true,
    };
    complete(f, [], [original]);
    const before = snapshot(f),
      [input] = f.store.listContextRecoveryInputs();
    f.store.importContextRecovery(
      input,
      output(input, {
        candidates: [
          {
            ...original,
            localId: "recovery",
            title: "복구한 분석",
            questionIds: kind === "role-change" ? [2, 3] : [2],
            responseIds: kind === "unresolved" ? [3] : [],
            uncertainties: [],
            needsContext: kind === "unresolved",
          },
        ],
        noncandidateRanges: kind === "noncandidate" ? [[3, 3]] : [],
      }),
    );
    expect(snapshot(f)).toBe(before);
    expect(f.store.listCandidates()[0]).toMatchObject({
      localId: "original",
      title: original.title,
      uncertainties: original.uncertainties,
      needsContext: true,
    });
    expect(f.store.summary()).toMatchObject({
      needsContextMessages: 2,
      semanticReviewRequiredMessages: 2,
      messageDispositions: { candidate: 0, needsContext: 2, noncandidate: 5 },
    });
  },
);

it.each([false, true])(
  "질문 overlap이 애매한 후보는 완전한 복구도 해제하지 않는다: %s",
  (needsContext) => {
    const f = fixture();
    const candidate = (localId: string, indexes: number[]): BatchCandidate => ({
      localId,
      title: "합성 분석",
      topic: "기술",
      questionIds: indexes.map((i) => f.batch.input.messages[i].id),
      responseIds: [],
      uncertainties: [],
      needsContext,
    });
    // The third contribution overlaps two independently identified questions.
    complete(
      f,
      [4],
      [candidate("a", [2]), candidate("b", [3]), candidate("c", [2, 3])],
    );
    const [input] = f.store.listContextRecoveryInputs();
    f.store.importContextRecovery(
      input,
      output(input, {
        candidates: [
          {
            ...candidate("recovery", []),
            questionIds: [2, 3],
            responseIds: [4],
            needsContext: true,
          },
        ],
      }),
    );
    const [next] = f.store.listContextRecoveryInputs();
    f.store.importContextRecovery(
      next,
      output(next, {
        candidates: [
          {
            ...candidate("resolved", []),
            questionIds: [2, 3],
            responseIds: [4],
            needsContext: false,
          },
        ],
      }),
    );
    expect(
      f.store.listCandidates().find((c) => c.localId === "c")?.needsContext,
    ).toBe(true);
    expect(f.store.summary()).toMatchObject({
      needsContextMessages: 3,
      semanticReviewRequiredMessages: 3,
    });
  },
);

it.each([false, true])(
  "복구 뒤 추가된 overlap 근거와 링크 없는 unresolved 검토는 사라지지 않는다: %s",
  (addEvidence) => {
    const f = fixture({ ...ready, maxMessages: 4, overlap: 2 });
    const first = f.batches[0],
      second = f.batches[1];
    const original: BatchCandidate = {
      localId: "original",
      title: "부분 분석",
      topic: "기술",
      questionIds: [first.input.messages[2].id],
      responseIds: addEvidence ? [first.input.messages[3].id] : [],
      uncertainties: [],
      needsContext: true,
    };
    const importBatch = (batch: typeof first, candidates: BatchCandidate[]) => {
      const evidence = new Set(
        candidates.flatMap((c) => [...c.questionIds, ...c.responseIds]),
      );
      f.store.importResult(
        batch.batchId,
        JSON.stringify({
          batchId: batch.batchId,
          inputHash: batch.inputHash,
          complete: true,
          candidates,
          dispositions: batch.input.messages
            .filter((m) => !evidence.has(m.id))
            .map((m) => ({
              messageId: m.id,
              kind: "noncandidate",
              reason: "합성 분류",
            })),
        }),
      );
    };
    if (!addEvidence) {
      f.store.importResult(
        second.batchId,
        JSON.stringify({
          batchId: second.batchId,
          inputHash: second.inputHash,
          complete: true,
          candidates: [],
          dispositions: second.input.messages.map((m, i) => ({
            messageId: m.id,
            kind: i === 1 ? "needs-context" : "noncandidate",
            reason: "합성 분류",
          })),
        }),
      );
    }
    importBatch(first, [original]);
    const packets = f.store.listContextRecoveryInputs();
    const input = packets.find((p) => p.blocks[0].batchId === first.batchId)!;
    f.store.importContextRecovery(
      input,
      output(input, {
        candidates: [
          {
            ...original,
            questionIds: [2],
            responseIds: [3],
            needsContext: false,
          },
        ],
      }),
    );
    expect(f.store.listCandidates()[0].needsContext).toBe(false);
    if (addEvidence)
      importBatch(second, [
        {
          ...original,
          localId: "late",
          responseIds: [second.input.messages[2].id],
        },
      ]);
    if (addEvidence)
      expect(f.store.listCandidates()[0]).toMatchObject({
        needsContext: true,
        sourceBatchIds: [first.batchId, second.batchId].sort(),
        responseIds: [
          first.input.messages[3].id,
          second.input.messages[2].id,
        ].sort(),
      });
    if (addEvidence)
      expect(f.store.summary()).toMatchObject({
        importedCoveredMessages: 6,
        needsContextMessages: 3,
        semanticReviewRequiredMessages: 3,
        messageDispositions: { candidate: 0, needsContext: 3, noncandidate: 3 },
      });
    const late = (
      addEvidence ? f.store.listContextRecoveryInputs() : packets
    ).find((p) => p.blocks[0].batchId === second.batchId)!;
    f.store.importContextRecovery(late, output(late));
    expect(f.store.listCandidates()[0].needsContext).toBe(true);
    expect(f.store.summary()).toMatchObject({
      needsContextMessages: addEvidence ? 3 : 2,
      semanticReviewRequiredMessages: addEvidence ? 3 : 2,
    });
    if (addEvidence) {
      const db = new Database(join(f.store.directory, "jobs.sqlite"));
      try {
        db.prepare(
          "UPDATE jobs SET output_hash='synthetic-mismatch' WHERE id=?",
        ).run(second.batchId);
        expect(f.store.summary()).toMatchObject({
          importedCoveredMessages: 4,
          pendingMessages: 3,
          needsContextMessages: 0,
          semanticReviewRequiredMessages: 0,
          messageDispositions: { candidate: 2, noncandidate: 2, pending: 3 },
        });
      } finally {
        db.close();
      }
    }
    // Starting a new run must hide every old contribution and recovery.
    f.store.prepare([f.source], {
      ...ready,
      maxMessages: 4,
      overlap: 2,
      promptVersion: "new-run",
    });
    expect(f.store.listCandidates()).toEqual([]);
    expect(f.store.summary()).toMatchObject({
      importedCoveredMessages: 0,
      needsContextMessages: 0,
      semanticReviewRequiredMessages: 0,
      pendingMessages: 7,
    });
  },
);
