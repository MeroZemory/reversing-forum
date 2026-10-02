import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { ChatJobStore } from "../src/server/chat-pipeline/job-store";
import {
  editorialEvidence,
  type EditorialEvidence,
} from "../src/server/chat-pipeline/editorial-evidence";

// Private preparation only. Publishing still requires an independent review,
// a real editor session and a passing Jev result for each public snapshot.
const directory = resolve("data/chat-pipeline");
const outputDirectory = join(directory, "editorial-batches");
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const write = (name: string, value: unknown) => {
  mkdirSync(outputDirectory, { recursive: true });
  const path = join(outputDirectory, name);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
};
const versions = {
  basisVersion: "nonpersonal-technical-v1",
  rightsVersion: "independent-expression-v1",
  rulesVersion: "historical-editorial-v1",
};
type DraftResult = {
  complete: boolean;
  entries: {
    candidateKey: string;
    title: string;
    body: string;
    tags: string[];
    ready: boolean;
    reasons: string[];
  }[];
};
type ReviewResult = {
  complete: boolean;
  entries: {
    candidateKey: string;
    publicHash: string;
    passed: boolean;
    meaning: boolean;
    privacy: boolean;
    rights: boolean;
    externalTransfer: boolean;
    reasons: string[];
  }[];
};
type Evidence = EditorialEvidence & { segment?: number };
type DraftInput = {
  entries: {
    candidateKey: string;
    period: string;
    questionIds: string[];
    responseIds: string[];
    evidence: Evidence[];
    uncertainties: string[];
    needsContext: boolean;
  }[];
};

const processingRecord = join(directory, "processing-record.json");
const instruction =
  "전체 후보를 각각 검토하고 공개용 편집 글로 독립적으로 다시 작성하세요. 원문 문장·고유한 코드·표현·개인 경험·닉네임을 복사하지 마세요. 질문의 논점, 제안된 방법, 반박, 해결 여부와 미확인 사항을 명확히 구분하세요. 기록에 없는 성공·동의·인물·첨부 내용을 만들지 마세요. 현재 기술적 사실을 새로 검증한 것처럼 쓰지 말고 기록 당시 제안임을 밝히세요. 필요한 답변이나 맥락이 없으면 ready:false로 남기세요. 단순 도구 이름 나열이나 불완전한 질문으로 글 수를 늘리지 마세요. 질문과 응답이 이어지고 학습에 쓸 논점이 있으면 당시 제안이 틀려도 후보가 될 수 있습니다. 게임 치트 제작·배포·판매, 특정 서비스의 접근통제 우회 실행법·도구 배포는 보류하세요. 일반적인 디버깅·운영체제·보안 연구 개념은 자체 작성한 설명으로 다룰 수 있습니다. 실행 코드나 원본 URL을 옮기지 마세요. title은 검색 가능한 구체적인 논점, body는 독자가 바로 이해할 수 있는 한국어 Markdown, tags는 주제·도구 1~4개입니다. 일본어·한자를 쓰지 마세요. 근거 id와 발언자 별칭은 본문에 넣지 마세요. 입력에 있는 모든 candidateKey마다 결과를 하나 반환하고 complete는 실제 전체 처리 여부입니다.";

async function main() {
  const command = process.argv[2];
  if (command === "prepare") {
    const store = new ChatJobStore(directory);
    const db = new Database(join(directory, "jobs.sqlite"), { readonly: true });
    try {
      const candidates = store.listCandidates();
      const byId = new Map<string, Evidence>();
      for (const batch of store.listBatches())
        for (const m of batch.input.messages)
          if (!byId.has(m.id)) byId.set(m.id, m);
      const entries = candidates.map((c) => {
        const ids = [...new Set([...c.questionIds, ...c.responseIds])];
        const { evidence, period } = editorialEvidence(db, ids, byId);
        return {
          candidateKey: c.candidateKey,
          title: c.title,
          topic: c.topic,
          questionIds: c.questionIds,
          responseIds: c.responseIds,
          period,
          uncertainties: c.uncertainties,
          needsContext: c.needsContext,
          evidence,
        };
      });
      const packets: { packetId: string; input: string; output: string }[] = [];
      for (let start = 0; start < entries.length; start += 20) {
        const selected = entries.slice(start, start + 20);
        const packetId = digest(selected);
        const input = write(`${packetId}.draft.input.json`, {
          packetId,
          instructions:
            instruction +
            " evidence는 로컬 원본 순서로 정렬했고 segment 숫자가 바뀌면 대화 구간이 달라집니다. 같은 구간도 질문·응답 관계를 보증하지 않으므로 논점과 응답 대상을 직접 대조하세요. [링크 제거]는 최소화 과정에서 주소를 제외했다는 표시입니다. 원본에 주소가 없었다거나 주소가 유실됐다고 쓰지 마세요.",
          scope: versions,
          entries: selected,
        });
        packets.push({
          packetId,
          input,
          output: join(outputDirectory, `${packetId}.draft.output.json`),
        });
      }
      write("manifest.json", { packets });
      console.log(
        JSON.stringify({
          candidates: entries.length,
          draftBatches: packets.length,
        }),
      );
    } finally {
      store.close();
      db.close();
    }
  } else if (command === "review") {
    const input = JSON.parse(
      readFileSync(resolve(process.argv[3]), "utf8"),
    ) as DraftInput;
    const output = JSON.parse(
      readFileSync(resolve(process.argv[4]), "utf8"),
    ) as DraftResult;
    if (
      !output.complete ||
      output.entries.length !== input.entries.length ||
      new Set(output.entries.map((e) => e.candidateKey)).size !==
        output.entries.length
    )
      throw new Error("incomplete-draft-batch");
    const prepared = output.entries.map((d) => {
      const original = input.entries.find(
        (e) => e.candidateKey === d.candidateKey,
      );
      if (!original) throw new Error("out-of-scope-draft");
      const publicData = {
        title: d.title.trim(),
        body: d.body.trim(),
        kind: "share" as const,
        tags: [...new Set(d.tags.map((t) => t.trim()))].sort(),
        provenance: {
          type: "chat-editorial" as const,
          period: original.period,
          verificationSummary:
            "기록의 질문·제안·미확인 사항을 구분해 편집했습니다. 제안의 현재 유효성은 별도로 확인해야 합니다.",
        },
      };
      return {
        candidateKey: d.candidateKey,
        publicHash: digest(publicData),
        ready: d.ready,
        reasons: d.reasons,
        publicData,
        original,
      };
    });
    const entries = prepared.filter((entry) => entry.ready);
    const draftHeld = prepared
      .filter((entry) => !entry.ready)
      .map((entry) => ({
        candidateKey: entry.candidateKey,
        reasons: entry.reasons,
        stage: "draft",
        independentlyReviewed: false,
      }));
    const packetId = digest({ entries, draftHeld });
    const path = write(`${packetId}.review.input.json`, {
      packetId,
      model: "gpt-6.1-sol",
      effort: "xhigh",
      scope: versions,
      instructions:
        "원자료가 아닌 최소화된 근거와 공개본을 독립 대조하세요. 각각 의미 왜곡·근거 없는 성공/합의·현재 사실로의 둔갑·잘못 연결된 질답, 개인정보, 원문/코드의 창작적 표현 복제, 치트 배포/실행 안내를 확인하세요. 자료는 기술적 사실과 방법의 독립 서술만 허용한 범위이고 제삼자 동의를 받았다고 추정하지 않습니다. scope에 포함된 비개인적 기술 정보의 처리 조건만 externalTransfer:true로 판단할 수 있습니다. ready:false 또는 근거 부족은 passed:false입니다. 본문을 임의로 고쳐 승인하지 말고 문제와 이유를 남기세요. publicHash와 candidateKey는 입력 그대로 반환하고 모든 항목에 passed,meaning,privacy,rights,externalTransfer 불리언과 reasons를 반환하세요. 한 항목이라도 점검하지 못하면 complete:false. 원문 URL·닉네임 대응·인증정보·외부 파일을 읽지 마세요. 한국어로만 작성하세요.",
      entries,
      draftHeld,
    });
    console.log(
      JSON.stringify({
        reviewInput: path,
        reviewOutput: path.replace(".input.json", ".output.json"),
        entries: entries.length,
      }),
    );
  } else if (command === "bundle") {
    const input = JSON.parse(readFileSync(resolve(process.argv[3]), "utf8"));
    const output = JSON.parse(
      readFileSync(resolve(process.argv[4]), "utf8"),
    ) as ReviewResult;
    if (
      !output.complete ||
      output.entries.length !== input.entries.length ||
      new Set(output.entries.map((e) => e.candidateKey)).size !==
        output.entries.length
    )
      throw new Error("incomplete-review-batch");
    if (!existsSync(processingRecord))
      throw new Error("processing-record-required");
    const referenceId = "review-" + digest(output);
    const reviews: unknown[] = [];
    let held = input.draftHeld?.length ?? 0;
    const entries = input.entries.flatMap((entry: any) => {
      const r = output.entries.find(
        (r) => r.candidateKey === entry.candidateKey,
      );
      if (
        !r ||
        r.publicHash !== digest(entry.publicData) ||
        r.publicHash !== entry.publicHash
      )
        throw new Error("review-snapshot-mismatch");
      reviews.push({
        candidateKey: r.candidateKey,
        publicHash: r.publicHash,
        passed:
          r.passed &&
          r.meaning &&
          r.privacy &&
          r.rights &&
          r.externalTransfer &&
          entry.ready,
        referenceId,
      });
      if (
        !r.passed ||
        !r.meaning ||
        !r.privacy ||
        !r.rights ||
        !r.externalTransfer ||
        !entry.ready
      ) {
        held++;
        return [];
      }
      const evidenceIds = entry.original.evidence.map((e: Evidence) => e.id);
      if (
        !evidenceIds.length ||
        evidenceIds.length > 99 ||
        /[\u3040-\u30ff\u3400-\u9fff]/u.test(
          JSON.stringify(entry.publicData),
        ) ||
        Buffer.byteLength(JSON.stringify(entry.publicData)) > 24_000
      ) {
        held++;
        return [];
      }
      return [
        {
          candidateKey: entry.candidateKey,
          sourceAliases: evidenceIds,
          publicData: entry.publicData,
          evidenceIds,
          reviewId: referenceId,
        },
      ];
    });
    const packetId = digest(input);
    const bundle = write(`${packetId}.bundle.json`, {
      ...versions,
      processingRecord,
      entries,
    });
    const review = write(`${packetId}.approved.json`, {
      model: "gpt-6.1-sol",
      effort: "xhigh",
      entries: reviews,
    });
    write(`${packetId}.dispositions.json`, {
      referenceId,
      held,
      draftHeld: input.draftHeld ?? [],
      reviews: output.entries,
    });
    console.log(
      JSON.stringify({ bundle, review, ready: entries.length, held }),
    );
  } else throw new Error("editorial-batch-command-required");
}
main().catch((error) => {
  const code =
    error instanceof Error && /^[a-z-]+$/.test(error.message)
      ? error.message
      : "editorial-batch-failed";
  console.error(code);
  process.exitCode = 1;
});
