import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { ChatJobStore } from "../src/server/chat-pipeline/job-store";
import {
  editorialEvidence,
  type EditorialEvidence,
} from "../src/server/chat-pipeline/editorial-evidence";
import {
  qualityPolicyVersion,
  editorialPromptVersion as promptVersion,
  editorialQualityInstruction as qualityInstruction,
  editorialDisplayIssues,
} from "../src/server/chat-pipeline/editorial-policy";

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
type EditorialSource = { title: string; url: string; notes: string };

function validateSources(value: unknown): asserts value is EditorialSource[] {
  if (!Array.isArray(value) || !value.length || value.length > 8)
    throw new Error("invalid-editorial-sources");
  for (const source of value) {
    if (
      !source ||
      typeof source !== "object" ||
      Object.keys(source).sort().join(",") !== "notes,title,url" ||
      ["title", "url", "notes"].some(
        (key) =>
          typeof source[key] !== "string" ||
          !source[key].trim() ||
          source[key] !== source[key].trim() ||
          /[\u0000-\u001f\u007f]/.test(source[key]),
      ) ||
      source.title.length > 200 ||
      source.url.length > 2048 ||
      source.notes.length > 4000
    )
      throw new Error("invalid-editorial-sources");
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      throw new Error("invalid-editorial-source-url");
    }
    // DNS names only; no local/IP targets, credentials, nonstandard ports or
    // secret-bearing query parameters. No network request or fact verification.
    if (
      !source.url.startsWith("https://") ||
      /[\s\\<>"`]/.test(source.url) ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
        url.hostname,
      ) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/i.test(
        url.hostname,
      ) ||
      [...url.searchParams.keys()].some((key) =>
        /auth|token|key|secret|password|credential|signature|session/i.test(
          key,
        ),
      )
    )
      throw new Error("invalid-editorial-source-url");
  }
}

function supplementPresent(
  original: DraftInput["entries"][number],
  body: string,
) {
  const sources = original.editorialSources;
  if (sources !== undefined) validateSources(sources);
  const prose = body.replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, "");
  const headings = [...prose.matchAll(/^### 편집자 보충\s*$/gm)];
  if (headings.length > 1)
    throw new Error("invalid-editorial-supplement-heading");
  const heading = headings[0];
  if (heading && !sources)
    throw new Error("editorial-supplement-sources-required");
  const start = heading ? heading.index! + heading[0].length : prose.length;
  const remainder = prose.slice(start);
  const end = remainder.search(/^#{1,3}\s/m);
  const section = heading ? remainder.slice(0, end < 0 ? undefined : end) : "";
  const outside =
    prose.slice(0, heading?.index ?? prose.length) +
    (end < 0 ? "" : remainder.slice(end));
  const citations = [
    ...section.matchAll(
      /\[[^\]\n]+\]\((https:\/\/(?:[^\s()]|\([^()\s]*\))+)\)|<(https:\/\/[^\s>]+)>/g,
    ),
  ].map((match) => match[1] ?? match[2]);
  if (
    heading &&
    !citations.some((url) => sources!.some((source) => source.url === url))
  )
    throw new Error("editorial-supplement-citation-required");
  if (
    heading &&
    citations.some((url) => !sources!.some((source) => source.url === url))
  )
    throw new Error("editorial-supplement-unsupplied-citation");
  // Only detectable reuse is checked here. Paraphrases and meaning still need
  // independent model review against this entry's evidence and supplied notes.
  if (
    sources?.some(
      (source) =>
        outside.includes(source.url) ||
        (outside.includes(source.notes) &&
          !original.evidence.some((e) => e.text.includes(source.notes))),
    )
  )
    throw new Error("editorial-supplement-unmarked");
  return Boolean(heading);
}

type DraftInput = {
  promptVersion: string;
  qualityPolicyVersion: string;
  entries: {
    candidateKey: string;
    period: string;
    questionIds: string[];
    responseIds: string[];
    evidence: Evidence[];
    editorialSources?: EditorialSource[];
    uncertainties: string[];
    needsContext: boolean;
  }[];
};

const processingRecord = join(directory, "processing-record.json");
const instruction =
  qualityInstruction +
  " 전체 후보를 각각 독립적으로 다시 작성하세요. 질문과 응답의 논점, 근거, 해결 여부를 비공개로 대조하고 판단은 reasons에 남기세요. title은 구체적인 논점, body는 한국어 Markdown, tags는 주제와 도구 1~4개입니다. 근거 id와 발언자 별칭은 본문에 넣지 마세요. quality는 위 기준의 평가 결과이며 quality:false면 ready:false입니다. 모든 candidateKey마다 결과를 하나 반환하고 complete는 전체 처리 여부입니다.";

async function main() {
  const command = process.argv[2];
  if (command === "prepare") {
    const args = process.argv.slice(3);
    const options = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      if (
        !["--candidate-keys", "--supplements"].includes(args[i]) ||
        !args[i + 1]?.trim() ||
        args[i + 1].startsWith("--") ||
        options.has(args[i])
      )
        throw new Error("invalid-prepare-arguments");
      options.set(args[i], args[i + 1]);
    }
    let requestedCandidateKeys: string[] | undefined;
    if (options.has("--candidate-keys")) {
      let value: unknown;
      try {
        value = JSON.parse(
          readFileSync(resolve(options.get("--candidate-keys")!), "utf8"),
        );
      } catch {
        throw new Error("invalid-candidate-keys-file");
      }
      if (
        !Array.isArray(value) ||
        !value.length ||
        value.some(
          (key) => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key),
        ) ||
        new Set(value).size !== value.length
      )
        throw new Error("invalid-candidate-keys");
      requestedCandidateKeys = value;
    }
    let supplements: Record<string, EditorialSource[]> = {};
    if (options.has("--supplements")) {
      let value: unknown;
      try {
        const file = readFileSync(
          resolve(options.get("--supplements")!),
          "utf8",
        );
        if (Buffer.byteLength(file) > 128_000) throw new Error();
        value = JSON.parse(file);
      } catch {
        throw new Error("invalid-supplements-file");
      }
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !Object.keys(value).length ||
        Object.keys(value).some((key) => !/^[a-f0-9]{64}$/.test(key))
      )
        throw new Error("invalid-supplements");
      for (const sources of Object.values(value)) validateSources(sources);
      supplements = value as Record<string, EditorialSource[]>;
    }
    const store = new ChatJobStore(directory);
    const db = new Database(join(directory, "jobs.sqlite"), { readonly: true });
    try {
      const allCandidates = store.listCandidates();
      const requested =
        requestedCandidateKeys && new Set(requestedCandidateKeys);
      const candidates = requested
        ? allCandidates.filter((c) => requested.has(c.candidateKey))
        : allCandidates;
      const found = new Set(candidates.map((c) => c.candidateKey));
      if (Object.keys(supplements).some((key) => !found.has(key)))
        throw new Error("out-of-scope-supplement");
      const missingCandidateKeys =
        requestedCandidateKeys?.filter((key) => !found.has(key)) ?? [];
      const deferredCandidateKeys = candidates
        .filter((c) => c.needsContext !== false)
        .map((c) => c.candidateKey);
      const selection = requestedCandidateKeys
        ? {
            requestedCandidateKeys,
            missingCandidateKeys,
          }
        : {};
      if (missingCandidateKeys.length) {
        write("manifest.json", {
          packets: [],
          ...selection,
          deferredCandidateKeys,
          deferredReason: "needs-context",
          preparationError: "candidate-keys-not-found",
        });
        throw new Error("candidate-keys-not-found");
      }
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
            ...(supplements[c.candidateKey]
              ? { editorialSources: supplements[c.candidateKey] }
              : {}),
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
        ...selection,
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
  } else if (command === "review" || command === "rereview") {
    const rereview = command === "rereview";
    const args = process.argv.slice(3);
    if (
      rereview &&
      ((args.length !== 2 && args.length !== 4) ||
        !args[0]?.trim() ||
        !args[1]?.trim() ||
        (args.length === 4 && (args[2] !== "--output-dir" || !args[3].trim())))
    )
      throw new Error("invalid-rereview-arguments");
    const input = JSON.parse(
      readFileSync(resolve(process.argv[3]), "utf8"),
    ) as DraftInput;
    const output = JSON.parse(
      readFileSync(resolve(process.argv[4]), "utf8"),
    ) as DraftResult;
    if (
      // This is a new review of an old draft, never a claim of current drafting.
      (rereview
        ? input.promptVersion !== "editorial-reusable-knowledge-v10"
        : input.promptVersion !== promptVersion) ||
      input.qualityPolicyVersion !== qualityPolicyVersion
    )
      throw new Error("draft-policy-mismatch");
    if (
      output.complete !== true ||
      output.entries.length !== input.entries.length ||
      new Set(input.entries.map((e) => e.candidateKey)).size !==
        input.entries.length ||
      new Set(output.entries.map((e) => e.candidateKey)).size !==
        output.entries.length
    )
      throw new Error("incomplete-draft-batch");
    const prepared = output.entries.map((d) => {
      const original = input.entries.find(
        (e) => e.candidateKey === d.candidateKey,
      );
      if (!original) throw new Error("out-of-scope-draft");
      const hasSupplement = supplementPresent(original, d.body);
      const publicData = {
        title: d.title.trim(),
        body: d.body.trim(),
        kind: "share" as const,
        tags: [...new Set(d.tags.map((t) => t.trim()))].sort(),
        provenance: {
          type: "chat-editorial" as const,
          period: original.period,
          verificationSummary:
            "기록의 질문·제안·미확인 사항을 구분해 편집했습니다. 제안의 현재 유효성은 별도로 확인해야 합니다." +
            (hasSupplement
              ? " 편집자 보충은 운영자가 확인해 제공한 공개 출처의 사실을 별도로 구분했습니다."
              : ""),
        },
      };
      const displayIssues = editorialDisplayIssues(publicData);
      return {
        candidateKey: d.candidateKey,
        publicHash: digest(publicData),
        ready:
          d.ready === true &&
          d.quality === true &&
          original.needsContext === false &&
          displayIssues.length === 0,
        quality: d.quality === true && displayIssues.length === 0,
        needsContext: original.needsContext,
        reasons: [
          ...d.reasons,
          ...displayIssues,
          ...(original.needsContext !== false ? ["needs-context"] : []),
          ...(d.quality !== true ? ["editorial-quality-not-approved"] : []),
        ],
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
    const reviewSource = rereview
      ? {
          reviewPromptVersion: promptVersion,
          draftPromptVersion: input.promptVersion,
          rereview: {
            command: "rereview",
            input: resolve(args[0]),
            output: resolve(args[1]),
            inputHash: digest(input),
            outputHash: digest(output),
          },
        }
      : {};
    const packetId = digest({
      qualityPolicyVersion,
      entries,
      draftHeld,
      ...(rereview
        ? { ...reviewSource, qualityInstruction }
        : { reviewPromptVersion: promptVersion, qualityInstruction }),
    });
    const reviewInput = {
      packetId,
      reviewPromptVersion: promptVersion,
      qualityPolicyVersion,
      ...reviewSource,
      model: "gpt-6.1-sol",
      effort: "xhigh",
      scope: versions,
      instructions:
        (rereview
          ? `현재 독립 검토 규칙 버전은 ${promptVersion}입니다. 이 입력은 ${input.promptVersion}로 작성한 초안의 새 재검토이며 구 검토나 승인을 재사용하지 마세요. `
          : "") +
        qualityInstruction +
        " 최소화된 근거와 정확한 공개본을 독립 대조하고 작성자의 quality 판정을 그대로 신뢰하지 마세요. qualityPolicyVersion은 입력 버전을 그대로 반환하세요. 원자료가 아닌 최소화된 근거와 공개본을 독립 대조하세요. 각각 의미 왜곡·근거 없는 성공/합의·현재 사실로의 둔갑·잘못 연결된 질답, 개인정보, 원문/코드의 창작적 표현 복제, 치트 배포/실행 안내를 확인하세요. 자료는 기술적 사실과 방법의 독립 서술만 허용한 범위이고 제삼자 동의를 받았다고 추정하지 않습니다. scope에 포함된 비개인적 기술 정보의 처리 조건만 externalTransfer:true로 판단할 수 있습니다. ready:false 또는 근거 부족은 passed:false입니다. 본문을 임의로 고쳐 승인하지 말고 문제와 이유를 남기세요. publicHash와 candidateKey는 입력 그대로 반환하고 모든 항목에 passed,quality,meaning,privacy,rights,externalTransfer 불리언과 qualityPolicyVersion 및 reasons를 반환하세요. 한 항목이라도 점검하지 못하면 complete:false. 원문 URL·닉네임 대응·인증정보·외부 파일을 읽지 마세요. 한국어로만 작성하세요.",
      entries,
      draftHeld,
    };
    let path: string;
    if (rereview) {
      const destination =
        args.length === 4 ? resolve(args[3]) : outputDirectory;
      mkdirSync(destination, { recursive: true });
      path = join(destination, `${packetId}.review.input.json`);
      try {
        // Even identical runs must not replace artifacts owned by the runner.
        writeFileSync(path, JSON.stringify(reviewInput), {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("rereview-input-exists");
        throw error;
      }
    } else {
      path = write(`${packetId}.review.input.json`, reviewInput);
    }
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
    const displayHeld: { candidateKey: string; reasons: string[] }[] = [];
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
      supplementPresent(entry.original, entry.publicData.body);
      const displayIssues = editorialDisplayIssues(entry.publicData);
      if (displayIssues.length)
        displayHeld.push({
          candidateKey: entry.candidateKey,
          reasons: displayIssues,
        });
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
          entry.ready === true &&
          displayIssues.length === 0,
        quality: r.quality === true && displayIssues.length === 0,
        reasons: [...r.reasons, ...displayIssues],
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
        entry.ready !== true ||
        displayIssues.length > 0
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
      displayHeld,
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
