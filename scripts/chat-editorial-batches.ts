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
const qualityPolicyVersion = "reusable-technical-knowledge-v3";
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
    quality: boolean;
    reasons: string[];
  }[];
};
type ReviewResult = {
  complete: boolean;
  entries: {
    candidateKey: string;
    publicHash: string;
    passed: boolean;
    quality: boolean;
    qualityPolicyVersion: string;
    meaning: boolean;
    privacy: boolean;
    rights: boolean;
    externalTransfer: boolean;
    reasons: string[];
  }[];
};
type Evidence = EditorialEvidence & { segment?: number };
type DraftInput = {
  promptVersion: string;
  qualityPolicyVersion: string;
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
const qualityInstruction =
  "후보의 title·topic·uncertainties는 이전 모델이 만든 가공 메타데이터이며 원자료 근거가 아닙니다. 대상 프로그램·도구·원인·결과는 evidence의 기술 내용에서만 확인하세요. 가공 제목에만 있는 ABEX 같은 이름을 원자료의 사실로 취급하거나 본문에 옮기지 마세요. 실제 원자료에 대상이 없고 이해에 그 대상이 필요하면 quality:false입니다. " +
  "글은 대화 이력이 아니라 다시 쓸 기술 지식으로 작성하세요. 원자료가 뒷받침하는 개념·조건·구체적인 방법·한계만 직접 설명하세요. 누가 질문했고 어떤 답이 이어졌는지, 이후 어떤 혼선이나 짧은 확인이 오갔는지는 본문에 넣지 마세요. 설명에 필요 없는 주변 논점·약어 혼동·후속 대화를 제거하세요. 답변이 모호한데 대화 경과와 '확인되지 않았다'는 문구만 남는 글은 quality:false입니다. 예를 들어 인터럽트 스택 상태의 질문 뒤에 MBR 약어 혼선과 문맥 전환 대화를 나열한 글은 보류하세요. 명확한 미해결 질문을 남길 경우에도 필요한 조건과 정확한 질문만 정리하고 잘못되거나 연결이 불명확한 답변을 덧붙이지 마세요. 대화 경과·누가 제안했는지·원자료에 없는 항목의 나열은 필요한 경우 비공개 reasons에만 남기세요. 본문은 독립 기술 설명 또는 구체적인 질문만 작성하세요. 기술적으로 중요한 조건·제안의 가설성·한계는 대화 경과가 아니라 해당 기술 내용의 조건·가능성·적용 범위로 직접 설명하세요. 확실하지 않은 내용을 검증된 사실로 바꾸거나 외부 지식으로 메우지 마세요. 근거가 부족한 결론은 제외하세요. 핵심 지식을 남길 수 없으면 글을 만들지 마세요. 과거 기록 시점과 출처는 별도 메타데이터로 표시하며 매 문장에서 대화였다는 사실을 반복하지 마세요. " +
  "공개 품질은 텍스트만으로 이해되는 명확한 기술 질문·문제 또는 원자료 응답에서 모호함 없이 확인되는 주제에 한정합니다. 의미 이해에 필요한 대상 프로그램·도구가 알려져 있는지, 구체적인 증상·행동·문제 또는 주제가 있는지, 질문과 응답이 같은 논점에 연결되는지, 첨부 없이 공개 텍스트만으로 이해되는지를 각각 평가하세요. 의미 이해에 필요한 대상 프로그램·도구가 불명확하거나 증상·행동이 모호하거나 필수 이미지·첨부가 없거나 추측이 필요하면 quality:false로 보류하세요. 예를 들어 '예외 설정을 바꾸면 프로그램이 실행되지 않는 문제'는 대상이 불명이므로 보류하고 OllyDbg라고 추정하지 마세요. pthread_join의 자원 처리나 DLL 호출 같은 구체적인 개념 주제에는 의미상 불필요한 실행 파일명·버전을 요구하지 마세요. 명확한 질문만 있거나 응답에서 구체적이고 재사용 가능한 설명이 모호함 없이 확인되어도 허용할 수 있습니다. 답변 없는 질문은 구체적으로 활용 가능한 맥락이 명확할 때만 허용합니다. 단순히 영어 PDF·블로그를 검색하라는 말, 불특정 사이트의 악성코드 샘플 안내, 누군가 질문했고 답변은 불명확하다는 내용뿐인 요약은 유용한 기술 질문·설명이 아니므로 보류하세요. 유용한 대상·절차·판단 기준 없이 일반 학습 조언·도구 이름 추천·방법 나열만 남으면 quality:false로 보류하세요. 이미지 누락은 텍스트에 질문·주제의 의미가 없고 이미지가 필수일 때 보류 사유입니다. 부분 답변은 원자료로 뒷받침되는 기술 내용과 적용 범위만 독립 설명할 수 있을 때 허용합니다. 틀리거나 연결이 불명확한 답변은 본문에서 제외하고, 부족한 내용을 고지하는 것만으로 품질을 통과시키지 마세요. needsContext:true인 후보는 통과시킬 수 없습니다. 원자료에 없는 대상·행동·원인·해결·첨부 내용을 만들지 마세요.";
const instruction =
  qualityInstruction +
  " 전체 후보를 각각 검토하고 공개용 편집 글로 독립적으로 다시 작성하세요. 원문 문장·고유한 코드·표현·개인 경험·닉네임을 복사하지 마세요. 질문과 응답의 논점·근거·해결 여부를 비공개로 대조하고 편집 판단은 reasons에 남기세요. 기록에 없는 성공·동의·인물을 만들지 마세요. 기술 내용의 가설성과 한계는 유지하되 당시 제안이나 답변 경과를 본문에 서술하지 마세요. 실제 게임의 무허가 부정사용 도구 제작·배포·판매와 특정 서비스의 접근통제 우회 실행법·도구 배포 안내는 보류하세요. 공격 원리의 개념 설명, 방어·탐지·분석 관점과 승인된 연습 문제의 디버깅 개념은 독립 서술할 수 있습니다. 실행 코드나 원본 URL을 옮기지 마세요. title은 검색 가능한 구체적인 논점, body는 독자가 바로 이해할 수 있는 한국어 Markdown, tags는 주제·도구 1~4개입니다. 일본어·한자를 쓰지 마세요. 근거 id와 발언자 별칭은 본문에 넣지 마세요. quality는 위 공개 품질 평가 결과이고 quality:false면 ready:false입니다. 입력에 있는 모든 candidateKey마다 결과를 하나 반환하고 complete는 실제 전체 처리 여부입니다.";
const promptVersion = "editorial-reusable-knowledge-v7";

async function main() {
  const command = process.argv[2];
  if (command === "prepare") {
    const store = new ChatJobStore(directory);
    const db = new Database(join(directory, "jobs.sqlite"), { readonly: true });
    try {
      const candidates = store.listCandidates();
      const deferredCandidateKeys = candidates
        .filter((c) => c.needsContext !== false)
        .map((c) => c.candidateKey);
      const byId = new Map<string, Evidence>();
      for (const batch of store.listBatches())
        for (const m of batch.input.messages)
          if (!byId.has(m.id)) byId.set(m.id, m);
      const entries = candidates
        .filter((c) => c.needsContext === false)
        .map((c) => {
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
        const packetId = digest({
          promptVersion,
          qualityPolicyVersion,
          instruction,
          entries: selected,
        });
        const input = write(`${packetId}.draft.input.json`, {
          packetId,
          promptVersion,
          qualityPolicyVersion,
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
      const counts = {
        candidates: candidates.length,
        draftCandidates: entries.length,
        deferredCandidates: deferredCandidateKeys.length,
      };
      write("manifest.json", {
        packets,
        ...counts,
        deferredCandidateKeys,
        deferredReason: "needs-context",
      });
      console.log(
        JSON.stringify({
          ...counts,
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
      input.promptVersion !== promptVersion ||
      input.qualityPolicyVersion !== qualityPolicyVersion
    )
      throw new Error("draft-policy-mismatch");
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
        ready:
          d.ready === true &&
          d.quality === true &&
          original.needsContext === false,
        quality: d.quality,
        needsContext: original.needsContext,
        reasons:
          original.needsContext !== false
            ? [...d.reasons, "needs-context"]
            : d.quality !== true
              ? [...d.reasons, "editorial-quality-not-approved"]
              : d.reasons,
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
    const packetId = digest({ qualityPolicyVersion, entries, draftHeld });
    const path = write(`${packetId}.review.input.json`, {
      packetId,
      qualityPolicyVersion,
      model: "gpt-6.1-sol",
      effort: "xhigh",
      scope: versions,
      instructions:
        qualityInstruction +
        " 최소화된 근거와 정확한 공개본을 독립 대조하고 작성자의 quality 판정을 그대로 신뢰하지 마세요. qualityPolicyVersion은 입력 버전을 그대로 반환하세요. 원자료가 아닌 최소화된 근거와 공개본을 독립 대조하세요. 각각 의미 왜곡·근거 없는 성공/합의·현재 사실로의 둔갑·잘못 연결된 질답, 개인정보, 원문/코드의 창작적 표현 복제, 치트 배포/실행 안내를 확인하세요. 자료는 기술적 사실과 방법의 독립 서술만 허용한 범위이고 제삼자 동의를 받았다고 추정하지 않습니다. scope에 포함된 비개인적 기술 정보의 처리 조건만 externalTransfer:true로 판단할 수 있습니다. ready:false 또는 근거 부족은 passed:false입니다. 본문을 임의로 고쳐 승인하지 말고 문제와 이유를 남기세요. publicHash와 candidateKey는 입력 그대로 반환하고 모든 항목에 passed,quality,meaning,privacy,rights,externalTransfer 불리언과 qualityPolicyVersion 및 reasons를 반환하세요. 한 항목이라도 점검하지 못하면 complete:false. 원문 URL·닉네임 대응·인증정보·외부 파일을 읽지 마세요. 한국어로만 작성하세요.",
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
    if (input.qualityPolicyVersion !== qualityPolicyVersion)
      throw new Error("review-policy-mismatch");
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
          r.passed === true &&
          r.quality === true &&
          r.qualityPolicyVersion === qualityPolicyVersion &&
          entry.quality === true &&
          entry.needsContext === false &&
          entry.original.needsContext === false &&
          r.meaning === true &&
          r.privacy === true &&
          r.rights === true &&
          r.externalTransfer === true &&
          entry.ready === true,
        quality: r.quality,
        qualityPolicyVersion: r.qualityPolicyVersion,
        meaning: r.meaning,
        privacy: r.privacy,
        rights: r.rights,
        externalTransfer: r.externalTransfer,
        referenceId,
      });
      if (
        r.passed !== true ||
        r.quality !== true ||
        r.qualityPolicyVersion !== qualityPolicyVersion ||
        entry.quality !== true ||
        entry.needsContext !== false ||
        entry.original.needsContext !== false ||
        r.meaning !== true ||
        r.privacy !== true ||
        r.rights !== true ||
        r.externalTransfer !== true ||
        entry.ready !== true
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
          needsContext: false,
          publicData: entry.publicData,
          evidenceIds,
          reviewId: referenceId,
        },
      ];
    });
    const packetId = digest(input);
    const bundle = write(`${packetId}.bundle.json`, {
      ...versions,
      qualityPolicyVersion,
      processingRecord,
      entries,
    });
    const review = write(`${packetId}.approved.json`, {
      qualityPolicyVersion,
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
