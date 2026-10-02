import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const policy = "reusable-technical-knowledge-v2";
const promptVersion = "editorial-reusable-knowledge-v5";
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
    write,
    read: (name: string) =>
      JSON.parse(readFileSync(resolve(root, name), "utf8")),
    run: (command: string) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            import.meta.resolve("tsx"),
            script,
            command,
            "input.json",
            "output.json",
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
      for (const requirement of [
        "대상 프로그램·도구",
        "구체적인 증상·행동·문제",
        "질문과 응답",
        "첨부",
        "OllyDbg라고 추정하지",
        "작성자의 quality 판정을 그대로 신뢰하지",
        "의미상 불필요한 실행 파일명·버전을 요구하지",
        "명확한 질문만 있거나",
        "영어 PDF·블로그",
        "이미지가 필수일 때",
        "글은 대화 이력이 아니라 다시 쓸 기술 지식",
        "MBR 약어 혼선과 문맥 전환 대화를 나열한 글은 보류",
        "핵심 지식을 남길 수 없으면 글을 만들지",
      ])
        expect(packet.instructions).toContain(requirement);
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
          body: question + " 기록에는 답변이 없어 해결 여부는 미확인이다.",
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

it("rejects old draft caches and review packets", () => {
  const f = fixture();
  try {
    f.write("input.json", {
      promptVersion: "editorial-qa-partial-v2",
      entries: [],
    });
    f.write("output.json", { complete: true, entries: [] });
    expect(() => f.run("review")).toThrow();
    expect(() => f.run("bundle")).toThrow();
  } finally {
    f.close();
  }
});
