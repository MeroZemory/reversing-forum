import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

// All writes use an actual authenticated server session. No direct post insertion.
const qualityPolicyVersion = "reusable-technical-knowledge-v3";
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
  needsContext: boolean;
  publicData: PublicData;
  evidenceIds: string[];
  reviewId: string;
};
type Bundle = {
  basisVersion: string;
  rightsVersion: string;
  rulesVersion: string;
  processingRecord: string;
  qualityPolicyVersion: string;
  entries: Entry[];
};
type ReviewFile = {
  model: "gpt-6.1-sol";
  effort: "xhigh";
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
    referenceId: string;
  }[];
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bundlePath = process.argv[2];
const reviewPath = process.argv[3];
const command = process.argv[4] || "ingest";
const replacePublished = process.argv[5] === "--replace-published";
if (
  !bundlePath ||
  !reviewPath ||
  !["ingest", "publish"].includes(command) ||
  process.argv.length > 6 ||
  (process.argv[5] && !replacePublished) ||
  (replacePublished && command !== "publish")
)
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

type Preview = {
  hash: string;
  revision: number;
  state: string;
  basisVersion: string;
  rightsVersion: string;
  rulesVersion: string;
  screeningStatus: string | null;
  post?: { id: string; status: string } | null;
};
async function call<T = Preview>(path: string, data: unknown): Promise<T> {
  const response = await fetch(`${session.origin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: session.origin,
      Cookie: session.cookie,
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(150_000),
  });
  if (!response.ok) throw new Error(`editorial-http-${response.status}`);
  return (await response.json()) as T;
}
async function curate(published: Preview) {
  if (published.state !== "published" || published.post?.status !== "published")
    throw new Error("server-snapshot-mismatch");
  const path = "/api/resources/curation";
  const snapshot = await call<{
    hash: string;
    version: string;
    eligibleGuides: string[];
    editorial: ({ hash: string; revision: number } & typeof versions) | null;
  }>(path, { action: "snapshot", postId: published.post.id });
  if (
    !snapshot.editorial ||
    snapshot.editorial.hash !== published.hash ||
    snapshot.editorial.revision !== published.revision ||
    Object.entries(versions).some(
      ([key, value]) =>
        snapshot.editorial![key as keyof typeof versions] !== value,
    )
  )
    throw new Error("server-snapshot-mismatch");
  if (!snapshot.eligibleGuides.length) return [];
  const result = await call<{ curated: boolean; guides: string[] }>(path, {
    action: "select",
    postId: published.post.id,
    hash: snapshot.hash,
    version: snapshot.version,
  });
  if (result.curated !== true) throw new Error("server-snapshot-mismatch");
  return result.guides;
}
async function current(key: string): Promise<Preview | null> {
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
      verdict?.passed !== true ||
      bundle.qualityPolicyVersion !== qualityPolicyVersion ||
      verdict.qualityPolicyVersion !== qualityPolicyVersion ||
      verdict.quality !== true ||
      entry.needsContext !== false ||
      verdict.meaning !== true ||
      verdict.privacy !== true ||
      verdict.rights !== true ||
      verdict.externalTransfer !== true ||
      review.entries.filter((r) => r.candidateKey === entry.candidateKey)
        .length !== 1 ||
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
      const sameSnapshot =
        existing?.hash === verdict.publicHash &&
        Object.entries(versions).every(
          ([key, value]) => existing[key as keyof typeof versions] === value,
        );
      // A confirmed rejection belongs to this snapshot. Do not reset it by
      // revising, reapproving, or retrying publication of unchanged material.
      if (sameSnapshot && existing.screeningStatus === "held") {
        held++;
        receipts.push({
          candidateKey: entry.candidateKey,
          state: existing.state,
          screeningStatus: existing.screeningStatus,
          post: existing.post ?? null,
        });
        continue;
      }
      // A corpus import must not replace an already curated public article.
      // Updating it requires an explicit run and the same full review gates.
      if (
        existing?.state === "published" &&
        existing.post?.status === "published" &&
        !sameSnapshot &&
        !replacePublished
      ) {
        published++;
        receipts.push({
          candidateKey: entry.candidateKey,
          state: "published",
          post: existing.post,
          incomingSnapshotSkipped: true,
        });
        continue;
      }
      if (
        existing?.state === "published" &&
        existing.post?.status === "published" &&
        sameSnapshot
      ) {
        const guides =
          command === "publish" ? await curate(existing) : undefined;
        published++;
        receipts.push({
          candidateKey: entry.candidateKey,
          state: "published",
          post: existing.post,
          guides,
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
            meaning: verdict.meaning,
            privacy: verdict.privacy,
            rights: verdict.rights,
            externalTransfer: verdict.externalTransfer,
          },
        },
      };
      // A staff quality hold invalidates an already published revision. Its
      // publication receipt must keep returning held, so only a newly reviewed
      // revision can restore it. A confirmed screening rejection was excluded
      // above and must never gain retries through this branch.
      const needsFreshRevision =
        existing?.state === "held" &&
        existing.post?.status === "held" &&
        existing.screeningStatus == null;
      let draft =
        sameSnapshot && !needsFreshRevision
          ? existing
          : existing
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
        if (draft.state !== "approved") {
          await call(`/api/editorial/${entry.candidateKey}`, {
            action: "review",
            ...target,
            review: {
              model: "sol",
              effort: "xhigh",
              referenceId: entry.reviewId,
              compared: true,
              checks: {
                meaning: verdict.meaning,
                privacy: verdict.privacy,
                rights: verdict.rights,
                externalTransfer: verdict.externalTransfer,
              },
            },
          });
          await call(`/api/editorial/${entry.candidateKey}`, {
            action: "approve",
            ...target,
          });
        }
        draft = await call(`/api/editorial/${entry.candidateKey}`, {
          action: "publish",
          ...target,
        });
      }
      const guides =
        command === "publish" &&
        draft.state === "published" &&
        draft.post?.status === "published"
          ? await curate(draft)
          : undefined;
      if (draft.state === "published" && draft.post?.status === "published")
        published++;
      else held++;
      receipts.push({
        candidateKey: entry.candidateKey,
        state: draft.state,
        post: draft.post ?? null,
        guides,
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
