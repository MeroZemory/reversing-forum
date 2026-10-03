import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ChatJobStore } from "../../src/server/chat-pipeline/job-store";
import {
  editorialDisplayIssues,
  editorialQualityInstruction,
  editorialPromptVersion as promptVersion,
  qualityPolicyVersion as sharedQualityPolicyVersion,
} from "../../src/server/chat-pipeline/editorial-policy";
import { SANITIZER_VERSION } from "../../src/server/chat-pipeline/prepare";

const policy = "reusable-technical-knowledge-v4";
const script = fileURLToPath(
  new URL("../../scripts/chat-editorial-batches.ts", import.meta.url),
);
const digest = (data: unknown) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");

// Synthetic minimized evidence only; these CLI commands do not invoke models.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "editorial-quality-synthetic-"));
  mkdirSync(join(root, "data/chat-pipeline"), { recursive: true });
  const write = (name: string, data: unknown) =>
    writeFileSync(join(root, name), JSON.stringify(data));
  write("data/chat-pipeline/processing-record.json", { synthetic: true });
  return {
    directory: join(root, "data/chat-pipeline"),
    write,
    read: (name: string) =>
      JSON.parse(readFileSync(resolve(root, name), "utf8")),
    run: (command: string, ...args: string[]) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            import.meta.resolve("tsx"),
            script,
            command,
            ...(args.length
              ? args
              : command === "prepare"
                ? []
                : ["input.json", "output.json"]),
          ],
          { cwd: root, stdio: "pipe", timeout: 20_000 },
        ).toString(),
      ),
    close: () => {
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
        throw Error("unexpected-test-directory");
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function prepareFixture(needsContext: boolean[]) {
  const f = fixture();
  const sources = [0, 1].map((part) => ({
    id: `synthetic-source-${part}`,
    bytes: new TextEncoder().encode(
      "연습방 카카오톡 대화\n--------------- 2026년 10월 2일 금요일 ---------------\n" +
        needsContext
          .map((_, i) => i)
          .filter((i) => i % 2 === part)
          .map(
            (i) =>
              `[가상발언자] [오전 9:${String(i).padStart(2, "0")}] 연습용 분석 질문 ${i}\n`,
          )
          .join(""),
    ),
  }));
  const seed = (flags: boolean[], version = "synthetic-extraction-v1") => {
    const store = new ChatJobStore(f.directory);
    try {
      store.prepare(sources, {
        targetPrepared: true,
        scopeApproved: true,
        externalApproved: true,
        sampleReviewed: true,
        scopeVersion: "synthetic-scope",
        reviewScopeVersion: "synthetic-scope",
        reviewRuleVersion: SANITIZER_VERSION,
        externalVersion: "synthetic-external",
        maxMessages: 100,
        overlap: 1,
        promptVersion: version,
      });
      for (const batch of store.listBatches()) {
        store.importResult(
          batch.batchId,
          JSON.stringify({
            batchId: batch.batchId,
            inputHash: batch.inputHash,
            complete: true,
            candidates: batch.input.messages.map((message) => {
              const index = Number(message.text.match(/(\d+)$/)![1]);
              return {
                localId: `synthetic-${index}`,
                title: `연습용 분석 질문 ${index}`,
                topic: "기술",
                questionIds: [message.id],
                responseIds: [],
                uncertainties: flags[index] ? ["필수 문맥 누락"] : [],
                needsContext: flags[index],
              };
            }),
            dispositions: [],
          }),
        );
      }
    } finally {
      store.close();
    }
  };
  const snapshot = () => {
    const store = new ChatJobStore(f.directory);
    try {
      return {
        candidates: store.listCandidates(),
        summary: store.summary(),
      };
    } finally {
      store.close();
    }
  };
  seed(needsContext);
  return { ...f, seed, snapshot };
}

it("prepares only resolved candidates across mixed sources without changing source storage or coverage", () => {
  const f = prepareFixture(Array.from({ length: 44 }, (_, i) => i % 2 === 0));
  try {
    const before = f.snapshot();
    const database = readFileSync(join(f.directory, "jobs.sqlite"));
    const counts = f.run("prepare");
    expect(counts).toEqual({
      candidates: 44,
      draftCandidates: 22,
      deferredCandidates: 22,
      draftBatches: 2,
    });
    const manifest = f.read(
      "data/chat-pipeline/editorial-batches/manifest.json",
    );
    expect(manifest.deferredCandidateKeys).toEqual(
      before.candidates
        .filter((c) => c.needsContext)
        .map((c) => c.candidateKey),
    );
    expect(manifest).toMatchObject({
      candidates: 44,
      draftCandidates: 22,
      deferredCandidates: 22,
      deferredReason: "needs-context",
    });
    const packets = manifest.packets.map((packet: { input: string }) =>
      f.read(packet.input),
    );
    expect(
      packets.map((packet: { entries: unknown[] }) => packet.entries.length),
    ).toEqual([20, 2]);
    const entries = packets.flatMap(
      (packet: { entries: ReturnType<typeof source>[] }) => packet.entries,
    );
    expect(
      entries.map((entry: ReturnType<typeof source>) => entry.candidateKey),
    ).toEqual(
      before.candidates
        .filter((c) => c.needsContext === false)
        .map((c) => c.candidateKey),
    );
    expect(
      entries.every(
        (entry: ReturnType<typeof source>) => entry.needsContext === false,
      ),
    ).toBe(true);
    for (const packet of packets) {
      expect(packet.promptVersion).toBe(promptVersion);
      expect(packet.qualityPolicyVersion).toBe(policy);
      expect(packet.packetId).toBe(
        digest({
          promptVersion,
          qualityPolicyVersion: policy,
          instruction: packet.instructions.split(" evidence는")[0],
          entries: packet.entries,
        }),
      );
    }
    expect(readFileSync(join(f.directory, "jobs.sqlite"))).toEqual(database);
    expect(f.snapshot()).toEqual(before);
    expect(f.run("prepare")).toEqual(counts);
    expect(
      f.read("data/chat-pipeline/editorial-batches/manifest.json"),
    ).toEqual(manifest);
  } finally {
    f.close();
  }
});

it("defers all unresolved candidates with zero LLM packets and no fabricated completions", () => {
  const f = prepareFixture([true, true, true, true]);
  try {
    const before = f.snapshot();
    expect(f.run("prepare")).toEqual({
      candidates: 4,
      draftCandidates: 0,
      deferredCandidates: 4,
      draftBatches: 0,
    });
    expect(
      f.read("data/chat-pipeline/editorial-batches/manifest.json"),
    ).toEqual({
      packets: [],
      candidates: 4,
      draftCandidates: 0,
      deferredCandidates: 4,
      deferredCandidateKeys: before.candidates.map((c) => c.candidateKey),
      deferredReason: "needs-context",
    });
    expect(readdirSync(join(f.directory, "editorial-batches"))).toEqual([
      "manifest.json",
    ]);
    expect(f.snapshot()).toEqual(before);
  } finally {
    f.close();
  }
});

it("makes a previously deferred candidate eligible when refreshed source processing resolves its context", () => {
  const f = prepareFixture([true, false]);
  try {
    f.run("prepare");
    const first = f.read("data/chat-pipeline/editorial-batches/manifest.json");
    expect(first.deferredCandidateKeys).toHaveLength(1);
    f.seed([false, false], "synthetic-extraction-v2");
    const before = f.snapshot();
    expect(f.run("prepare")).toEqual({
      candidates: 2,
      draftCandidates: 2,
      deferredCandidates: 0,
      draftBatches: 1,
    });
    const next = f.read("data/chat-pipeline/editorial-batches/manifest.json");
    expect(next.deferredCandidateKeys).toEqual([]);
    const packet = f.read(next.packets[0].input);
    expect(
      packet.entries.map(
        (entry: ReturnType<typeof source>) => entry.candidateKey,
      ),
    ).toContain(first.deferredCandidateKeys[0]);
    expect(next.packets[0].packetId).not.toBe(first.packets[0].packetId);
    expect(f.snapshot()).toEqual(before);
  } finally {
    f.close();
  }
});

function source(needsContext = false) {
  return {
    candidateKey: "synthetic",
    period: "synthetic-period",
    questionIds: ["q"],
    responseIds: ["a"],
    uncertainties: [],
    needsContext,
    evidence: [
      {
        id: "q",
        text: "x64dbg에서 연습용 실행 파일의 첫 예외에서 멈춘다. 예외를 대상에 전달하고 계속 실행하려면 어떻게 하는가?",
      },
      {
        id: "a",
        text: "x64dbg의 예외 처리 설정에서 대상에 전달하는 동작을 확인하라는 제안이다. 결과는 확인하지 않았다.",
      },
    ],
  };
}

it.each([false, true])(
  "requires explicit draft quality and resolved context (needsContext=%s)",
  (needsContext) => {
    const f = fixture();
    try {
      f.write("input.json", {
        promptVersion,
        qualityPolicyVersion: policy,
        entries: [source(needsContext)],
      });
      f.write("output.json", {
        complete: true,
        entries: [
          {
            candidateKey: "synthetic",
            title: "x64dbg의 예외 전달 설정",
            body: "연습용 실행 파일의 첫 예외에서 멈추는 현상에 대해 대상에 예외를 전달하는 설정을 확인하라는 제안이 있었다. 결과는 미확인이다.",
            tags: ["x64dbg"],
            ready: true,
            quality: true,
            reasons: [],
          },
        ],
      });
      const packet = f.read(f.run("review").reviewInput);
      expect(packet.entries).toHaveLength(needsContext ? 0 : 1);
      expect(packet.draftHeld).toHaveLength(needsContext ? 1 : 0);
      expect(packet.qualityPolicyVersion).toBe(policy);
      expect(packet.instructions).toContain(editorialQualityInstruction);
      expect(packet.instructions).toContain(
        "작성자의 quality 판정을 그대로 신뢰하지",
      );
    } finally {
      f.close();
    }
  },
);

it.each([false, undefined])(
  "holds draft quality=%s even when ready is true",
  (quality) => {
    const f = fixture();
    try {
      f.write("input.json", {
        promptVersion,
        qualityPolicyVersion: policy,
        entries: [source()],
      });
      f.write("output.json", {
        complete: true,
        entries: [
          {
            candidateKey: "synthetic",
            title: "예외 설정을 바꾸면 프로그램이 실행되지 않는 문제",
            body: "프로그램의 예외 설정을 바꾸면 실행되지 않는다.",
            tags: [],
            ready: true,
            quality,
            reasons: [],
          },
        ],
      });
      const packet = f.read(f.run("review").reviewInput);
      expect(packet.entries).toEqual([]);
      expect(packet.draftHeld[0].reasons).toContain(
        "editorial-quality-not-approved",
      );
    } finally {
      f.close();
    }
  },
);

it.each([
  {
    title: "예외 설정을 바꾸면 프로그램이 실행되지 않는 문제",
    quality: false,
    approved: false,
  },
  { qualityPolicyVersion: undefined, approved: false },
  { qualityPolicyVersion: "old-policy", approved: false },
  { quality: undefined, approved: false },
  {
    title: "필수 화면만 가리키며 오류가 난다는 질문",
    quality: false,
    approved: false,
  },
  {
    title: "영어 PDF와 블로그를 검색하라는 안내",
    quality: false,
    approved: false,
  },
  { needsContext: true, approved: false },
  { approved: true },
])("bundles only independently approved exact snapshots: %j", (change) => {
  const f = fixture();
  try {
    const publicData = {
      title: change.title ?? "x64dbg에서 첫 예외를 대상에 전달하는 설정",
      body: "연습용 실행 파일의 첫 예외 중단에 대해 x64dbg 예외 처리 설정을 확인하라는 제안이 있었다. 해결 여부는 미확인이다.",
      kind: "share",
      tags: ["x64dbg"],
      provenance: {
        type: "chat-editorial",
        period: "synthetic-period",
        verificationSummary: "Synthetic",
      },
    };
    const publicHash = digest(publicData);
    f.write("input.json", {
      qualityPolicyVersion: policy,
      entries: [
        {
          candidateKey: "synthetic",
          ready: true,
          quality: true,
          needsContext: change.needsContext ?? false,
          publicData,
          publicHash,
          original: source(change.needsContext),
        },
      ],
    });
    const {
      title: _title,
      needsContext: _context,
      approved,
      ...verdict
    } = change;
    f.write("output.json", {
      complete: true,
      entries: [
        {
          candidateKey: "synthetic",
          publicHash,
          passed: true,
          quality: true,
          qualityPolicyVersion: policy,
          meaning: true,
          privacy: true,
          rights: true,
          externalTransfer: true,
          reasons: [],
          ...verdict,
        },
      ],
    });
    const result = f.run("bundle");
    const bundle = f.read(result.bundle);
    const review = f.read(result.review);
    expect(bundle.qualityPolicyVersion).toBe(policy);
    expect(bundle.entries).toHaveLength(approved ? 1 : 0);
    expect(review.entries[0].passed).toBe(approved);
    expect(review.entries[0].publicHash).toBe(publicHash);
    if (approved) {
      expect(bundle.entries[0].needsContext).toBe(false);
      expect(review.entries[0]).toMatchObject({
        quality: true,
        qualityPolicyVersion: policy,
        meaning: true,
        privacy: true,
        rights: true,
        externalTransfer: true,
      });
    }
  } finally {
    f.close();
  }
});

it("accepts a self-contained conceptual question without a target executable or answer", () => {
  const f = fixture();
  try {
    const question =
      "pthread_join은 종료된 joinable 스레드의 자원을 회수하는가? join 전에 스레드가 종료된 경우에도 join이 필요한가?";
    f.write("input.json", {
      promptVersion,
      qualityPolicyVersion: policy,
      entries: [
        {
          ...source(),
          responseIds: [],
          evidence: [{ id: "q", text: question }],
        },
      ],
    });
    f.write("output.json", {
      complete: true,
      entries: [
        {
          candidateKey: "synthetic",
          title: "pthread_join과 종료된 스레드의 자원 회수",
          body: question,
          tags: ["pthread_join"],
          ready: true,
          quality: true,
          reasons: [],
        },
      ],
    });
    const packet = f.read(f.run("review").reviewInput);
    expect(packet.entries).toHaveLength(1);
    expect(packet.entries[0].original.responseIds).toEqual([]);
    expect(packet.entries[0].publicData.body).toContain(question);
  } finally {
    f.close();
  }
});

it("rejects a review hash after the public text changes", () => {
  const f = fixture();
  try {
    const before = {
      title: "x64dbg exception handling",
      body: "Synthetic original",
    };
    f.write("input.json", {
      qualityPolicyVersion: policy,
      entries: [
        {
          candidateKey: "synthetic",
          ready: true,
          quality: true,
          needsContext: false,
          publicData: { ...before, body: "Changed public text" },
          publicHash: digest(before),
          original: source(),
        },
      ],
    });
    f.write("output.json", {
      complete: true,
      entries: [
        {
          candidateKey: "synthetic",
          publicHash: digest(before),
          passed: true,
          quality: true,
          qualityPolicyVersion: policy,
          meaning: true,
          privacy: true,
          rights: true,
          externalTransfer: true,
          reasons: [],
        },
      ],
    });
    expect(() => f.run("bundle")).toThrow();
  } finally {
    f.close();
  }
});

it.each([
  "editorial-qa-partial-v2",
  "editorial-reusable-knowledge-v6",
  "editorial-reusable-knowledge-v7",
  "editorial-reusable-knowledge-v10",
])("rejects old draft cache %s and review packets", (oldPromptVersion) => {
  const f = fixture();
  try {
    f.write("input.json", {
      promptVersion: oldPromptVersion,
      qualityPolicyVersion: policy,
      entries: [],
    });
    f.write("output.json", { complete: true, entries: [] });
    expect(() => f.run("review")).toThrow();
    f.write("input.json", {
      qualityPolicyVersion: "old-policy",
      entries: [],
    });
    expect(() => f.run("bundle")).toThrow();
  } finally {
    f.close();
  }
});

function rereviewFixture() {
  const f = fixture();
  const input = {
    promptVersion: "editorial-reusable-knowledge-v10",
    qualityPolicyVersion: policy,
    entries: [
      source(),
      {
        ...source(),
        candidateKey: "other",
        evidence: [{ id: "other-q", text: "서브루틴은 무엇인가요?" }],
        questionIds: ["other-q"],
        responseIds: [],
      },
    ],
  };
  const output = {
    complete: true,
    entries: input.entries
      .map((entry) => ({
        candidateKey: entry.candidateKey,
        title:
          entry.candidateKey === "other"
            ? "서브루틴의 의미"
            : "x64dbg 예외 전달 설정",
        body:
          entry.candidateKey === "other"
            ? "서브루틴은 무엇인가요?"
            : "대상에 예외를 전달하는 설정은 어떻게 확인하나요?",
        tags: ["debugging"],
        ready: true,
        quality: true,
        reasons: ["합성 초안 근거"],
      }))
      .reverse(),
  };
  const save = () => {
    f.write("input.json", input);
    f.write("output.json", output);
  };
  save();
  return { ...f, input, output, save };
}

it("gives normal reviews a current-rule identity without overwriting legacy review inputs or outputs for identical bodies", () => {
  const f = rereviewFixture();
  try {
    f.input.promptVersion = promptVersion;
    f.save();
    const initial = f.run("review");
    const packet = f.read(initial.reviewInput);
    const legacyId = digest({
      qualityPolicyVersion: policy,
      entries: packet.entries,
      draftHeld: packet.draftHeld,
    });
    const legacyInput = `data/chat-pipeline/editorial-batches/${legacyId}.review.input.json`;
    const legacyOutput = `data/chat-pipeline/editorial-batches/${legacyId}.review.output.json`;
    const legacyPacket = {
      ...packet,
      packetId: legacyId,
      reviewPromptVersion: "editorial-reusable-knowledge-v10",
      instructions: "synthetic previous review rules",
    };
    const legacyVerdict = {
      complete: true,
      entries: ["synthetic previous verdict"],
    };
    f.write(legacyInput, legacyPacket);
    f.write(legacyOutput, legacyVerdict);

    const current = f.run("review");
    expect(current).toEqual(initial);
    expect(packet.reviewPromptVersion).toBe(promptVersion);
    expect(packet.instructions).toContain(editorialQualityInstruction);
    expect(packet.packetId).toBe(
      digest({
        qualityPolicyVersion: policy,
        entries: packet.entries,
        draftHeld: packet.draftHeld,
        reviewPromptVersion: promptVersion,
        qualityInstruction: editorialQualityInstruction,
      }),
    );
    expect(packet.packetId).not.toBe(legacyId);
    expect(current.reviewInput).not.toContain(`${legacyId}.review.input.json`);
    expect(current.reviewOutput).not.toContain(
      `${legacyId}.review.output.json`,
    );
    expect(f.read(legacyInput)).toEqual(legacyPacket);
    expect(f.read(legacyOutput)).toEqual(legacyVerdict);
    expect(f.read(current.reviewInput).entries).toEqual(legacyPacket.entries);
  } finally {
    f.close();
  }
});

it("creates a fresh current-policy review of v10 drafts with isolated original evidence and immutable source attribution", () => {
  const f = rereviewFixture();
  try {
    mkdirSync(join(f.directory, "editorial-batches"));
    f.write("data/chat-pipeline/editorial-batches/manifest.json", {
      packets: ["untouched"],
    });
    const beforeInput = readFileSync(resolve(f.directory, "../../input.json"));
    const beforeOutput = readFileSync(
      resolve(f.directory, "../../output.json"),
    );
    const result = f.run(
      "rereview",
      "input.json",
      "output.json",
      "--output-dir",
      "private-rereview",
    );
    const packet = f.read(result.reviewInput);
    expect(result.reviewInput).toContain("private-rereview");
    expect(result.reviewOutput).toBe(
      result.reviewInput.replace(".input.json", ".output.json"),
    );
    expect(packet).toMatchObject({
      qualityPolicyVersion: policy,
      reviewPromptVersion: promptVersion,
      draftPromptVersion: "editorial-reusable-knowledge-v10",
      rereview: {
        command: "rereview",
        inputHash: digest(f.input),
        outputHash: digest(f.output),
      },
    });
    expect(packet).not.toHaveProperty("promptVersion");
    expect(packet.instructions).toContain(promptVersion);
    expect(packet.instructions).toContain(editorialQualityInstruction);
    expect(packet.instructions).toContain("original.evidence");
    expect(packet.entries).toHaveLength(2);
    expect(packet.draftHeld).toEqual([]);
    for (const entry of packet.entries) {
      expect(entry.original).toEqual(
        f.input.entries.find(
          (original) => original.candidateKey === entry.candidateKey,
        ),
      );
      expect(entry.publicData.body).toBe(
        f.output.entries.find(
          (draft) => draft.candidateKey === entry.candidateKey,
        )!.body,
      );
      expect(entry.publicHash).toBe(digest(entry.publicData));
      expect(entry).not.toHaveProperty("passed");
    }
    expect(readFileSync(packet.rereview.input)).toEqual(beforeInput);
    expect(readFileSync(packet.rereview.output)).toEqual(beforeOutput);
    expect(
      f.read("data/chat-pipeline/editorial-batches/manifest.json"),
    ).toEqual({ packets: ["untouched"] });
    const beforePacket = readFileSync(result.reviewInput);
    expect(() =>
      f.run(
        "rereview",
        "input.json",
        "output.json",
        "--output-dir",
        "private-rereview",
      ),
    ).toThrow("rereview-input-exists");
    expect(readFileSync(result.reviewInput)).toEqual(beforePacket);

    // The same body under current drafting must have a distinct review identity.
    f.input.promptVersion = promptVersion;
    f.save();
    const regular = f.read(f.run("review").reviewInput);
    expect(regular.packetId).not.toBe(packet.packetId);
    expect(regular.entries).toEqual(packet.entries);
  } finally {
    f.close();
  }
});

it.each(["editorial-reusable-knowledge-v9", promptVersion, "unknown"])(
  "limits rereview to the explicit v10 source version (%s)",
  (version) => {
    const f = rereviewFixture();
    try {
      f.input.promptVersion = version;
      f.save();
      expect(() => f.run("rereview")).toThrow("draft-policy-mismatch");
      expect(readdirSync(f.directory)).toEqual(["processing-record.json"]);
    } finally {
      f.close();
    }
  },
);

it("rejects a mismatched quality policy in rereview", () => {
  const f = rereviewFixture();
  try {
    f.input.qualityPolicyVersion = "old-policy";
    f.save();
    expect(() => f.run("rereview")).toThrow("draft-policy-mismatch");
  } finally {
    f.close();
  }
});

it("rejects truthy non-boolean completion in rereview", () => {
  const f = rereviewFixture();
  try {
    f.write("output.json", { ...f.output, complete: "true" });
    expect(() => f.run("rereview")).toThrow("incomplete-draft-batch");
  } finally {
    f.close();
  }
});

it("rejects a changed rereview body against the independently returned snapshot hash", () => {
  const f = rereviewFixture();
  try {
    const result = f.run("rereview");
    const packet = f.read(result.reviewInput);
    const review = {
      complete: true,
      entries: packet.entries.map(
        (entry: { candidateKey: string; publicHash: string }) => ({
          candidateKey: entry.candidateKey,
          publicHash: entry.publicHash,
          passed: true,
          quality: true,
          qualityPolicyVersion: policy,
          meaning: true,
          privacy: true,
          rights: true,
          externalTransfer: true,
          reasons: [],
        }),
      ),
    };
    packet.entries[0].publicData.body = "검토 뒤 변경한 본문입니다.";
    f.write("changed-review-input.json", packet);
    f.write("synthetic-review-output.json", review);
    expect(() =>
      f.run(
        "bundle",
        "changed-review-input.json",
        "synthetic-review-output.json",
      ),
    ).toThrow("review-snapshot-mismatch");
    expect(readdirSync(join(f.directory, "editorial-batches"))).toEqual([
      `${packet.packetId}.review.input.json`,
    ]);
  } finally {
    f.close();
  }
});

it.each([
  "incomplete",
  "missing",
  "duplicate-output",
  "duplicate-input",
  "foreign",
])(
  "rejects incomplete or non-bijective rereview source batches (%s)",
  (failure) => {
    const f = rereviewFixture();
    try {
      if (failure === "incomplete") f.output.complete = false;
      if (failure === "missing") f.output.entries.pop();
      if (failure === "duplicate-output")
        f.output.entries[1] = f.output.entries[0];
      if (failure === "duplicate-input")
        f.input.entries[1] = f.input.entries[0];
      if (failure === "foreign") f.output.entries[0].candidateKey = "foreign";
      f.save();
      expect(() => f.run("rereview")).toThrow();
      expect(readdirSync(f.directory)).toEqual(["processing-record.json"]);
    } finally {
      f.close();
    }
  },
);

it.each(["quality", "ready", "context", "display"])(
  "preserves draft and current display holds in rereview (%s)",
  (failure) => {
    const f = rereviewFixture();
    try {
      const draft = f.output.entries.find(
        (entry) => entry.candidateKey === "synthetic",
      )!;
      if (failure === "quality") draft.quality = false;
      if (failure === "ready") draft.ready = false;
      if (failure === "context") f.input.entries[0].needsContext = true;
      if (failure === "display") draft.body = "예외 설정이 제안됐습니다.";
      f.save();
      const packet = f.read(f.run("rereview").reviewInput);
      expect(
        packet.entries.map(
          (entry: { candidateKey: string }) => entry.candidateKey,
        ),
      ).toEqual(["other"]);
      expect(packet.draftHeld).toMatchObject([
        {
          candidateKey: "synthetic",
          stage: "draft",
          independentlyReviewed: false,
        },
      ]);
    } finally {
      f.close();
    }
  },
);

it.each([
  ["input.json"],
  ["input.json", "output.json", "extra"],
  ["input.json", "output.json", "--other", "private"],
  ["input.json", "output.json", "--output-dir", " "],
])("rejects invalid rereview arguments %j", (...args) => {
  const f = rereviewFixture();
  try {
    expect(() => f.run("rereview", ...args)).toThrow(
      "invalid-rereview-arguments",
    );
    expect(readdirSync(f.directory)).toEqual(["processing-record.json"]);
  } finally {
    f.close();
  }
});

it("selects exactly 44 requested keys and explicitly defers unresolved targets", () => {
  const f = prepareFixture(Array.from({ length: 50 }, (_, i) => i % 3 === 0));
  try {
    const before = f.snapshot();
    const database = readFileSync(join(f.directory, "jobs.sqlite"));
    const selected = before.candidates.slice(0, 44);
    const keys = selected.map((c) => c.candidateKey).reverse();
    f.write("keys.private.json", keys);
    const result = f.run("prepare", "--candidate-keys", "keys.private.json");
    const manifest = f.read(
      "data/chat-pipeline/editorial-batches/manifest.json",
    );
    expect(result.candidates).toBe(44);
    expect(manifest.requestedCandidateKeys).toEqual(keys);
    expect(manifest.missingCandidateKeys).toEqual([]);
    expect(manifest.deferredCandidateKeys).toEqual(
      selected.filter((c) => c.needsContext).map((c) => c.candidateKey),
    );
    const packets = manifest.packets.map((packet: { input: string }) =>
      f.read(packet.input),
    );
    expect(
      packets.flatMap((packet: { entries: ReturnType<typeof source>[] }) =>
        packet.entries.map((entry) => entry.candidateKey),
      ),
    ).toEqual(
      selected.filter((c) => !c.needsContext).map((c) => c.candidateKey),
    );
    for (const packet of packets)
      expect(packet.instructions).toContain(editorialQualityInstruction);
    expect(readFileSync(join(f.directory, "jobs.sqlite"))).toEqual(database);
    expect(f.snapshot()).toEqual(before);
  } finally {
    f.close();
  }
});

it("fails the entire selection on missing keys and records missing and unresolved targets", () => {
  const f = prepareFixture([true, false]);
  try {
    const before = f.snapshot();
    const keys = before.candidates.map((c) => c.candidateKey);
    const missing = "f".repeat(64);
    f.write("keys.private.json", [...keys, missing]);
    expect(() =>
      f.run("prepare", "--candidate-keys", "keys.private.json"),
    ).toThrow();
    expect(
      f.read("data/chat-pipeline/editorial-batches/manifest.json"),
    ).toMatchObject({
      packets: [],
      requestedCandidateKeys: [...keys, missing],
      missingCandidateKeys: [missing],
      deferredCandidateKeys: before.candidates
        .filter((c) => c.needsContext)
        .map((c) => c.candidateKey),
      preparationError: "candidate-keys-not-found",
    });
    expect(f.snapshot()).toEqual(before);
  } finally {
    f.close();
  }
});

it.each(
  [
    null,
    {},
    [],
    [12],
    [""],
    [" f"],
    ["g".repeat(64)],
    ["a".repeat(64), "a".repeat(64)],
  ].map((keys) => ({ keys })),
)(
  "rejects invalid key arrays %j before writing preparation output",
  ({ keys }) => {
    const f = fixture();
    try {
      f.write("keys.private.json", keys);
      expect(() =>
        f.run("prepare", "--candidate-keys", "keys.private.json"),
      ).toThrow();
      expect(readdirSync(f.directory)).toEqual(["processing-record.json"]);
    } finally {
      f.close();
    }
  },
);

it.each(
  [
    ["--candidate-keys"],
    ["--other", "keys.json"],
    ["--candidate-keys", "keys.json", "extra"],
    ["--candidate-keys", " "],
  ].map((args) => ({ args })),
)("rejects invalid prepare arguments %j", ({ args }) => {
  const f = fixture();
  try {
    expect(() => f.run("prepare", ...args)).toThrow();
    expect(readdirSync(f.directory)).toEqual(["processing-record.json"]);
  } finally {
    f.close();
  }
});

it("rejects unreadable and malformed key files without exposing their contents", () => {
  const f = fixture();
  try {
    f.write("keys.private.json", []);
    writeFileSync(
      resolve(f.directory, "../../malformed.json"),
      "private-invalid-json",
    );
    for (const name of ["missing.json", "malformed.json"]) {
      try {
        f.run("prepare", "--candidate-keys", name);
        throw new Error("expected-failure");
      } catch (error) {
        const stderr = (error as { stderr: Buffer }).stderr.toString();
        expect(stderr.trim()).toBe("invalid-candidate-keys-file");
      }
    }
    expect(readdirSync(f.directory)).toEqual(["processing-record.json"]);
  } finally {
    f.close();
  }
});

it.each([
  "제안됐습니다.",
  "언급되었습니다.",
  "나열됐다.",
  "EAX·AX",
  "EAX → AX",
  "“EAX”",
])(
  "holds a visible display issue at both draft and review gates: %s",
  (body) => {
    const f = fixture();
    try {
      f.write("input.json", {
        promptVersion,
        qualityPolicyVersion: policy,
        entries: [source()],
      });
      f.write("output.json", {
        complete: true,
        entries: [
          {
            candidateKey: "synthetic",
            title: "레지스터 질문",
            body,
            tags: ["CPU"],
            ready: true,
            quality: true,
            reasons: [],
          },
        ],
      });
      const draftPacket = f.read(f.run("review").reviewInput);
      expect(draftPacket.entries).toEqual([]);
      expect(draftPacket.draftHeld[0].reasons).toEqual(
        editorialDisplayIssues({ title: "레지스터 질문", body }),
      );
      const publicData = { title: "레지스터 질문", body };
      const publicHash = digest(publicData);
      f.write("input.json", {
        qualityPolicyVersion: policy,
        entries: [
          {
            candidateKey: "synthetic",
            ready: true,
            quality: true,
            needsContext: false,
            original: source(),
            publicData,
            publicHash,
          },
        ],
      });
      f.write("output.json", {
        complete: true,
        entries: [
          {
            candidateKey: "synthetic",
            publicHash,
            passed: true,
            quality: true,
            qualityPolicyVersion: policy,
            meaning: true,
            privacy: true,
            rights: true,
            externalTransfer: true,
            reasons: [],
          },
        ],
      });
      const result = f.run("bundle");
      expect(f.read(result.bundle).entries).toEqual([]);
      expect(f.read(result.review).entries[0]).toMatchObject({
        passed: false,
        quality: false,
        reasons: editorialDisplayIssues(publicData),
      });
      expect(result.held).toBe(1);
    } finally {
      f.close();
    }
  },
);

it.each([
  "EAX와 AX는 어떻게 다른가요?",
  "이 환경에서만 확인했으며 모든 버전에 적용되는지는 미확인입니다.",
  "이 방법만으로 원인을 확정할 수 없습니다.",
  "`mov eax, 1`\n\n```asm\ncmp eax, 0\nje done\n```",
  "`a → b`와 `x · y` 식을 비교합니다.",
  "```text\n제안됐습니다. →\n```",
])(
  "does not treat technical syntax or real limitations as display violations: %s",
  (body) => {
    expect(editorialDisplayIssues({ title: "기술 질문", body })).toEqual([]);
  },
);

it("shares concise structure and fidelity rules rather than requiring expansion", () => {
  for (const rule of [
    "1~3문장",
    "1. 목록",
    "- 목록",
    "필수 목록을 강요하지",
    "답을 발명하지",
    "가설성",
    "기술적 제약",
    "CPU 명령",
    "원본 URL",
    "~합니다/~인가요",
    "메타데이터나 비공개 reasons",
    "의미나 사실 검증이 아니며",
  ])
    expect(editorialQualityInstruction).toContain(rule);
});

it("rejects v3 draft and independent review packets", () => {
  const f = fixture();
  try {
    f.write("input.json", {
      promptVersion,
      qualityPolicyVersion: "reusable-technical-knowledge-v3",
      entries: [],
    });
    f.write("output.json", { complete: true, entries: [] });
    expect(() => f.run("review")).toThrow();
    expect(() => f.run("bundle")).toThrow();
  } finally {
    f.close();
  }
});

it("preserves standard CPU syntax and source constraints without rewriting at the draft gate", () => {
  const f = fixture();
  try {
    const body =
      "32비트 연습 환경의 명령 `mov eax, 1`을 확인합니다.\n\n```asm\ncmp eax, 0\nje done\n```\n\n이 환경 밖에서의 동작은 미확인입니다.";
    f.write("input.json", {
      promptVersion,
      qualityPolicyVersion: policy,
      entries: [{ ...source(), evidence: [{ id: "q", text: body }] }],
    });
    f.write("output.json", {
      complete: true,
      entries: [
        {
          candidateKey: "synthetic",
          title: "32비트 연습 환경의 EAX 비교",
          body,
          tags: ["CPU"],
          ready: true,
          quality: true,
          reasons: [],
        },
      ],
    });
    const packet = f.read(f.run("review").reviewInput);
    expect(packet.entries).toHaveLength(1);
    const entry = packet.entries[0];
    expect(entry.publicData.body).toBe(body);
    expect(entry.original.evidence).toEqual([{ id: "q", text: body }]);
    expect(entry.publicHash).toBe(digest(entry.publicData));
  } finally {
    f.close();
  }
});

it("requires the shared current quality policy in the independent review output schema", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL(
        "../../src/server/chat-pipeline/schemas/review.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const item = schema.properties.entries.items;
  expect(item.required).toContain("qualityPolicyVersion");
  expect(item.properties.qualityPolicyVersion.enum).toEqual([
    sharedQualityPolicyVersion,
  ]);
  expect(item.properties.qualityPolicyVersion.enum).not.toContain(
    "reusable-technical-knowledge-v3",
  );
  expect(policy).toBe(sharedQualityPolicyVersion);
});
