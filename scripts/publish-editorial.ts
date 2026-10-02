import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

// All writes use an actual authenticated server session. No direct post insertion.
const directory = resolve("data/chat-pipeline");
type PublicData = {
  title: string;
  body: string;
  kind: "share";
  tags: string[];
  provenance: {
    type: "chat-editorial" | "independent-guide";
    period: string;
    verificationSummary: string;
  };
};
type Entry = {
  candidateKey: string;
  sourceAliases: string[];
  publicData: PublicData;
  evidenceIds: string[];
  reviewId: string;
};
type Bundle = {
  basisVersion: string;
  rightsVersion: string;
  rulesVersion: string;
  processingRecord: string;
  entries: Entry[];
};
type ReviewFile = {
  model: "gpt-6.1-sol";
  effort: "xhigh";
  entries: {
    candidateKey: string;
    publicHash: string;
    passed: boolean;
    referenceId: string;
  }[];
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bundlePath = process.argv[2];
const reviewPath = process.argv[3];
const command = process.argv[4] || "ingest";
if (!bundlePath || !reviewPath || !["ingest", "publish"].includes(command))
  throw new Error("usage-publish-editorial-bundle-review-ingest-or-publish");
const bundle = JSON.parse(readFileSync(resolve(bundlePath), "utf8")) as Bundle;
const review = JSON.parse(
  readFileSync(resolve(reviewPath), "utf8"),
) as ReviewFile;
const session = JSON.parse(
  readFileSync(resolve(directory, "editorial-session.json"), "utf8"),
) as { origin: string; cookie: string };
const versions = {
  basisVersion: bundle.basisVersion,
  rightsVersion: bundle.rightsVersion,
  rulesVersion: bundle.rulesVersion,
};
if (
  review.model !== "gpt-6.1-sol" ||
  review.effort !== "xhigh" ||
  !bundle.processingRecord ||
  !existsSync(resolve(bundle.processingRecord))
)
  throw new Error("missing-processing-or-review-record");
const processing = JSON.parse(
  readFileSync(resolve(bundle.processingRecord), "utf8"),
);
if (
  processing.scope !== "independently-written-nonpersonal-technical-material" ||
  processing.basisVersion !== versions.basisVersion ||
  processing.rightsVersion !== versions.rightsVersion ||
  processing.rulesVersion !== versions.rulesVersion ||
  processing.permitted !== true
)
  throw new Error("processing-scope-mismatch");

async function call(path: string, data: unknown) {
  const response = await fetch(`${session.origin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: session.origin,
      Cookie: session.cookie,
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`editorial-http-${response.status}`);
  return (await response.json()) as {
    hash: string;
    revision: number;
    state: string;
    post?: { id: string; status: string };
  };
}
async function current(key: string) {
  const response = await fetch(`${session.origin}/api/editorial/${key}`, {
    headers: { Cookie: session.cookie },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`editorial-http-${response.status}`);
  return await response.json();
}
async function main() {
  mkdirSync(directory, { recursive: true });
  await call("/api/editorial", { action: "basis", ...versions, allowed: true });
  let ingested = 0,
    published = 0,
    held = 0,
    errors = 0;
  const receipts: unknown[] = [];
  for (const entry of bundle.entries) {
    // A real independent review must name this exact public snapshot.
    const verdict = review.entries.find(
      (r) => r.candidateKey === entry.candidateKey,
    );
    if (
      !verdict?.passed ||
      verdict.publicHash !== digest(entry.publicData) ||
      verdict.referenceId !== entry.reviewId ||
      !entry.evidenceIds.length
    ) {
      held++;
      continue;
    }
    try {
      const existing = await current(entry.candidateKey);
      if (existing?.state === "withdrawn") {
        held++;
        receipts.push({ candidateKey: entry.candidateKey, state: "withdrawn" });
        continue;
      }
      if (
        existing?.state === "published" &&
        existing.hash === verdict.publicHash &&
        Object.entries(versions).every(
          ([key, value]) => existing[key] === value,
        )
      ) {
        published++;
        receipts.push({
          candidateKey: entry.candidateKey,
          state: "published",
          post: existing.post,
        });
        continue;
      }
      const input = {
        candidateKey: entry.candidateKey,
        revision: existing ? existing.revision + 1 : 1,
        sourceAliases: entry.sourceAliases,
        ...versions,
        publicData: entry.publicData,
        privateEvidence: {
          referenceIds: [...entry.evidenceIds, entry.reviewId],
          checks: {
            meaning: true,
            privacy: true,
            rights: true,
            externalTransfer: true,
          },
        },
      };
      let draft = existing
        ? await call(`/api/editorial/${entry.candidateKey}`, {
            action: "revise",
            revision: existing.revision,
            hash: existing.hash,
            basisVersion: existing.basisVersion,
            rightsVersion: existing.rightsVersion,
            rulesVersion: existing.rulesVersion,
            draft: input,
          })
        : await call("/api/editorial", { action: "ingest", ...input });
      ingested++;
      if (
        command === "publish" &&
        draft.state !== "published" &&
        draft.state !== "withdrawn"
      ) {
        const target = {
          revision: draft.revision,
          hash: draft.hash,
          ...versions,
        };
        if (draft.hash !== verdict.publicHash)
          throw new Error("server-snapshot-mismatch");
        await call(`/api/editorial/${entry.candidateKey}`, {
          action: "review",
          ...target,
          review: {
            model: "sol",
            effort: "xhigh",
            referenceId: entry.reviewId,
            compared: true,
            checks: {
              meaning: true,
              privacy: true,
              rights: true,
              externalTransfer: true,
            },
          },
        });
        await call(`/api/editorial/${entry.candidateKey}`, {
          action: "approve",
          ...target,
        });
        draft = await call(`/api/editorial/${entry.candidateKey}`, {
          action: "publish",
          ...target,
        });
      }
      if (draft.post?.status === "published") published++;
      else held++;
      receipts.push({
        candidateKey: entry.candidateKey,
        state: draft.state,
        post: draft.post ?? null,
      });
    } catch (error) {
      errors++;
      receipts.push({
        candidateKey: entry.candidateKey,
        error:
          error instanceof Error &&
          /^editorial-http-\d+$|^server-snapshot-mismatch$/.test(error.message)
            ? error.message
            : "publication-failed",
      });
    }
    // Progress contains counts only; no source content or credentials.
    if ((ingested + errors) % 10 === 0)
      console.log(JSON.stringify({ ingested, published, held, errors }));
  }
  writeFileSync(
    resolve(directory, `publication-${digest(bundle).slice(0, 16)}.json`),
    JSON.stringify({ ingested, published, held, errors, receipts }, null, 2),
  );
  console.log(JSON.stringify({ ingested, published, held, errors }));
  if (errors) process.exitCode = 1;
}
main().catch(() => {
  console.error(
    "편집 글을 처리하지 못했습니다. 세션과 처리 기록을 확인해 주세요.",
  );
  process.exitCode = 1;
});
