import "server-only";
import { createHash } from "node:crypto";
import { db } from "../db";
import {
  atomicQuestions,
  type Block,
  type ComparisonSnapshot,
  type DetectorOptions,
  type DuplicateAssessment,
  type DuplicateFallback,
  type DuplicateInput,
  type EmbeddingBackend,
  type Judgment,
  type PublicDocument,
} from "./types";
import {
  copyFingerprint,
  hash,
  localEmbeddings,
  noSpaceLength,
  splitBlocks,
  validVector,
} from "./embedding";
import { JUDGE_VERSION, jevJudge, timedJudge, validateJudgment } from "./judge";
import { candidateRetriever } from "./retrieval";
export { retrieveCandidateUnion } from "./retrieval";
export type {
  DuplicateAssessment,
  DuplicateFallback,
  DuplicateInput,
  ComparisonSnapshot,
  EmbeddingBackend,
} from "./types";
export { atomicQuestions } from "./types";

export const LIMITS = {
  requestBytes: 16_000,
  indexBatchPosts: 128,
  changedBlocksPerRun: 2048,
  candidatePosts: 32,
  candidateBytes: 40_000,
  judgeBytes: 60_000,
  relatedLimit: 20,
} as const;
type Cached = {
  document: PublicDocument;
  blocks: Block[];
  vectors: number[][];
};
const documentHash = (document: DuplicateInput | PublicDocument) =>
  hash(JSON.stringify([document.title, document.body, document.tags]));
const corpusHash = (documents: PublicDocument[]) =>
  hash(JSON.stringify(documents.map((d) => [d.id, documentHash(d)])));
const uncertain = (evidence: string): DuplicateAssessment => ({
  verdict: "uncertain",
  relatedPostIds: [],
  evidence,
  corpusHash: "",
});

/** Full current published snapshot, across every batch. Never hashes pending/held rows.
 * Publication integration must compare this under its cross-process publication lease. */
function hashPublicStore(store: typeof db, excludePostId?: string): string {
  const digest = createHash("sha256").update("[");
  let first = true;
  for (const row of store
    .prepare(
      "SELECT id,title,body,tags FROM posts WHERE status='published' AND id<>? ORDER BY id",
    )
    .iterate(excludePostId ?? "") as Iterable<{
    id: string;
    title: string;
    body: string;
    tags: string;
  }>) {
    if (!first) digest.update(",");
    first = false;
    digest.update(
      JSON.stringify([
        row.id,
        documentHash({ ...row, tags: JSON.parse(row.tags) }),
      ]),
    );
  }
  return digest.update("]").digest("hex");
}
export function publicCorpusHash(excludePostId?: string): string {
  return hashPublicStore(db, excludePostId);
}

export function initDuplicateTables(store = db): void {
  store.exec(`CREATE TABLE IF NOT EXISTS duplicate_vectors (
    post_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, model_version TEXT NOT NULL,
    blocks TEXT NOT NULL, vectors TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS duplicate_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT, input_hash TEXT NOT NULL, corpus_hash TEXT NOT NULL,
    judge_version TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS duplicate_relations (
    post_id TEXT NOT NULL, related_id TEXT NOT NULL,
    source_hash TEXT NOT NULL, target_hash TEXT NOT NULL, corpus_hash TEXT,
    PRIMARY KEY(post_id, related_id)
  );`);
}

export function interpretJudgment(
  judgment: Judgment,
  blocks: Block[],
  ids: string[],
): DuplicateAssessment {
  const { answers: a, coverage } = judgment;
  ids = judgment.relatedIds ?? ids;
  const weighted = blocks.filter((b) => b.weight > 0);
  if (
    atomicQuestions.some((name) => a[name] === "uncertain") ||
    coverage.some((c) => c === "uncertain")
  )
    return uncertain("ambiguous-comparison");
  if (
    judgment.relatedIds &&
    ((a.related_topic === "yes" && !ids.length) ||
      (a.related_topic === "no" && ids.length))
  )
    return uncertain("inconsistent-related-comparison");
  const useful = [
    a.new_evidence,
    a.correction,
    a.answer_fulfills,
    a.novel_synthesis,
  ].some((c) => c === "yes");
  const total = blocks.reduce((sum, b) => sum + b.weight, 0);
  const covered = blocks.reduce(
    (sum, b, i) => sum + (coverage[i] === "yes" ? b.weight : 0),
    0,
  );
  if (
    (covered > 0 && a.related_topic === "no") ||
    (covered === total &&
      a.sameconditions === "yes" &&
      !useful &&
      a.no_meaningful_novelty === "no")
  )
    return uncertain("inconsistent-comparison");
  if (
    !total ||
    !weighted.length ||
    (a.no_meaningful_novelty === "yes" &&
      (useful || a.sameconditions !== "yes" || covered !== total))
  )
    return uncertain("inconsistent-comparison");
  if (a.no_meaningful_novelty === "yes" && covered === total)
    return {
      verdict: "duplicate",
      relatedPostIds: ids,
      evidence: "fully-covered-without-useful-contribution",
      corpusHash: "",
    };
  if (a.no_meaningful_novelty !== "no")
    return uncertain("unresolved-contribution");
  if (covered > 0)
    return {
      verdict: "overlap",
      relatedPostIds: ids,
      evidence: "overlap-with-additional-contribution",
      corpusHash: "",
    };
  // All actual NEW blocks were judged, and the full article explicitly contributes something.
  return {
    verdict: a.related_topic === "yes" ? "related" : "distinct",
    relatedPostIds: a.related_topic === "yes" ? ids : [],
    evidence: "additional-contribution",
    corpusHash: "",
  };
}

/** Instantiate with a store for isolated tests. Test doubles are impossible in production.
 * Production fallback is an explicitly supplied, paid/accounted actual LLM adapter. */
export function createDuplicateDetector(options: DetectorOptions = {}) {
  if (options.testOnly && process.env.NODE_ENV === "production")
    throw new Error("duplicate-test-dependencies-forbidden");
  const store = options.store ?? db;
  if (!options.readOnly) initDuplicateTables(store);
  const readDocuments = store.transaction(
    (excludePostId?: string): PublicDocument[] => {
      const documents: PublicDocument[] = [];
      let after: string | null = null;
      while (true) {
        const rows = store
          .prepare(
            "SELECT id,title,body,tags FROM posts WHERE status='published' AND id<>? AND (? IS NULL OR id>?) ORDER BY id LIMIT ?",
          )
          .all(excludePostId ?? "", after, after, LIMITS.indexBatchPosts) as {
          id: string;
          title: string;
          body: string;
          tags: string;
        }[];
        for (const row of rows) {
          const tags: unknown = JSON.parse(row.tags);
          if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string"))
            throw new Error("invalid-public-tags");
          documents.push({ ...row, tags });
        }
        if (rows.length < LIMITS.indexBatchPosts) break;
        after = rows.at(-1)!.id;
      }
      return documents;
    },
  );
  function documents(excludePostId?: string): PublicDocument[] {
    // Keyset pages share a SQLite read snapshot, even across publishing processes.
    return readDocuments.deferred(excludePostId);
  }
  function record(snapshot: ComparisonSnapshot, evidence: unknown): void {
    store
      .prepare(
        "INSERT INTO duplicate_evidence(input_hash,corpus_hash,judge_version,evidence,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        documentHash(snapshot.input),
        snapshot.corpusHash,
        JUDGE_VERSION,
        JSON.stringify(evidence),
        new Date().toISOString(),
      );
    store
      .prepare(
        "DELETE FROM duplicate_evidence WHERE id NOT IN (SELECT id FROM duplicate_evidence ORDER BY id DESC LIMIT 256)",
      )
      .run();
  }
  async function embeddings(): Promise<EmbeddingBackend> {
    if (options.testOnly && process.env.NODE_ENV === "production")
      throw new Error("duplicate-test-dependencies-forbidden");
    return options.testOnly?.embeddings ?? (await localEmbeddings());
  }
  async function embedBlocks(
    blocks: Block[],
    backend: EmbeddingBackend,
  ): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < blocks.length; offset += 8) {
      const batch = blocks.slice(offset, offset + 8);
      const result = await backend.embed(
        batch.map((b) => `passage: ${b.context}\n${b.text}`),
      );
      if (result.length !== batch.length || !result.every(validVector))
        throw new Error("invalid-embeddings");
      vectors.push(...result);
    }
    return vectors;
  }
  async function* corpusVectors(
    publicDocuments: PublicDocument[],
    backend: EmbeddingBackend,
  ): AsyncGenerator<Cached> {
    store
      .prepare(
        "DELETE FROM duplicate_vectors WHERE post_id NOT IN (SELECT id FROM posts WHERE status='published') OR model_version<>?",
      )
      .run(backend.version);
    let changedCount = 0;
    for (const document of publicDocuments) {
      const contentHash = documentHash(document);
      const cached = store
        .prepare(
          "SELECT blocks,vectors FROM duplicate_vectors WHERE post_id=? AND content_hash=? AND model_version=?",
        )
        .get(document.id, contentHash, backend.version) as
        { blocks: string; vectors: string } | undefined;
      let blocks: Block[] | undefined;
      let vectors: number[][] | undefined;
      if (cached) {
        try {
          const parsed: unknown = JSON.parse(cached.vectors);
          const spans = JSON.parse(cached.blocks) as Block[];
          if (
            Array.isArray(spans) &&
            spans.length > 0 &&
            spans.length <= 96 &&
            spans.every(
              (b, i) =>
                Number.isInteger(b.start) &&
                Number.isInteger(b.end) &&
                b.start === (i ? spans[i - 1].end : 0) &&
                b.end > b.start &&
                b.end <= document.body.length &&
                b.text === document.body.slice(b.start, b.end) &&
                typeof b.context === "string" &&
                b.weight === noSpaceLength(b.text),
            ) &&
            spans.at(-1)!.end === document.body.length &&
            Array.isArray(parsed) &&
            parsed.length === spans.length &&
            parsed.every(validVector)
          ) {
            blocks = spans;
            vectors = parsed;
          }
        } catch {
          /* Corrupt cache must be rebuilt, never treated as a negative match. */
        }
      }
      if (!vectors || !blocks) {
        blocks = await splitBlocks(document, backend);
        changedCount += blocks.length;
        if (changedCount > LIMITS.changedBlocksPerRun)
          throw new Error("index-batch-incomplete");
        vectors = await embedBlocks(blocks, backend);
      } else {
        // An unchanged public version needs neither tokenization, inference nor a SQLite rewrite.
        yield { document, blocks, vectors };
        continue;
      }
      // Awaited work may race a withdrawal/edit: only cache the current public version.
      const current = store
        .prepare(
          "SELECT title,body,tags FROM posts WHERE id=? AND status='published'",
        )
        .get(document.id) as
        { title: string; body: string; tags: string } | undefined;
      if (
        current &&
        hash(
          JSON.stringify([
            current.title,
            current.body,
            JSON.parse(current.tags),
          ]),
        ) === contentHash
      ) {
        store
          .prepare("INSERT OR REPLACE INTO duplicate_vectors VALUES(?,?,?,?,?)")
          .run(
            document.id,
            contentHash,
            backend.version,
            JSON.stringify(blocks),
            JSON.stringify(vectors),
          );
      }
      yield { document, blocks, vectors };
    }
  }
  async function assessDuplicate(
    input: DuplicateInput,
    review: { independentReview?: boolean } = {},
  ): Promise<DuplicateAssessment> {
    try {
      if (
        !input ||
        typeof input.title !== "string" ||
        typeof input.body !== "string" ||
        !Array.isArray(input.tags) ||
        !input.tags.every((t) => typeof t === "string") ||
        (input.excludePostId !== undefined &&
          typeof input.excludePostId !== "string") ||
        !noSpaceLength(input.body) ||
        Buffer.byteLength(JSON.stringify(input)) > LIMITS.requestBytes
      )
        return uncertain("invalid-or-oversize-input");
      // Copy input so callers cannot alter a comparison while an async judge is running.
      input = { ...input, tags: [...input.tags] };
      const publicDocuments = documents(input.excludePostId);
      const before = corpusHash(publicDocuments);
      const finish = (result: DuplicateAssessment) => {
        // No stale or newly private existence/IDs can escape, even following a long async call.
        if (hashPublicStore(store, input.excludePostId) !== before)
          return { ...uncertain("public-corpus-changed"), corpusHash: before };
        return { ...result, corpusHash: before };
      };
      if (!publicDocuments.length)
        return finish({
          verdict: "distinct",
          relatedPostIds: [],
          evidence: "empty-public-corpus",
          corpusHash: before,
        });
      const exact = publicDocuments.filter(
        (d) =>
          copyFingerprint(d.body) === copyFingerprint(input.body) &&
          d.title === input.title &&
          JSON.stringify(d.tags) === JSON.stringify(input.tags),
      );
      if (exact.length)
        return finish({
          verdict: "duplicate",
          relatedPostIds: exact.map((d) => d.id),
          evidence: "exact-copy",
          corpusHash: before,
        });
      let blocks: Block[];
      let ranked: string[] = [];
      let embeddingFailure = false;
      try {
        const backend = await embeddings();
        blocks = await splitBlocks(input, backend);
        const vectors = await embedBlocks(blocks, backend);
        const retriever = candidateRetriever(input, blocks, vectors);
        for await (const old of corpusVectors(publicDocuments, backend))
          retriever.visit(old);
        ranked = retriever.result();
      } catch {
        embeddingFailure = true;
        // A failed/incomplete archive index cannot supply a reliable subset to an LLM.
        if (
          publicDocuments.length > LIMITS.candidatePosts ||
          Buffer.byteLength(JSON.stringify(publicDocuments)) >
            LIMITS.candidateBytes
        )
          return finish(uncertain("embedding-or-index-unavailable"));
        // An actual full-text LLM fallback can replace a failed retrieval tool, without truncation.
        blocks = [];
        for (let start = 0; start < input.body.length; start += 640) {
          const end = Math.min(start + 640, input.body.length);
          const text = input.body.slice(start, end);
          blocks.push({
            start,
            end,
            text,
            context: input.title,
            weight: noSpaceLength(text),
          });
        }
      }
      // Union ALL new blocks plus document lexical/copy hits. Never cut an overflowing union.
      const candidates = publicDocuments
        .filter((d) => embeddingFailure || ranked.includes(d.id))
        .sort((a, b) => {
          const ai = ranked.indexOf(a.id),
            bi = ranked.indexOf(b.id);
          return (
            (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) ||
            a.id.localeCompare(b.id)
          );
        });
      if (
        candidates.length > LIMITS.candidatePosts ||
        Buffer.byteLength(JSON.stringify(candidates)) > LIMITS.candidateBytes
      )
        return finish(uncertain("candidate-union-limit"));
      const snapshot: ComparisonSnapshot = {
        version: JUDGE_VERSION,
        corpusHash: before,
        input,
        candidates,
        blocks,
      };
      if (
        Buffer.byteLength(JSON.stringify(snapshot)) > 48_000 ||
        blocks.length > 96
      )
        return finish(uncertain("full-comparison-limit"));
      if (hashPublicStore(store, input.excludePostId) !== before)
        return finish(uncertain("public-corpus-changed"));
      let judgment: Judgment | null = null;
      let source = "jev";
      if (!embeddingFailure && !review.independentReview) {
        try {
          const adapter = options.testOnly?.judge ?? jevJudge;
          judgment = validateJudgment(
            await timedJudge((signal) =>
              adapter(structuredClone(snapshot), signal),
            ),
            blocks.length,
            candidates.map((d) => d.id),
          );
        } catch {
          /* A tool error requires actual LLM fallback or uncertain. */
        }
      }
      if (
        (!judgment ||
          interpretJudgment(judgment, blocks, []).verdict === "uncertain") &&
        options.fallback &&
        !review.independentReview
      ) {
        source = "fallback";
        try {
          judgment = validateJudgment(
            await timedJudge((signal) =>
              options.fallback!(structuredClone(snapshot), signal),
            ),
            blocks.length,
            candidates.map((d) => d.id),
          );
        } catch {
          judgment = null;
        }
      }
      if (
        (!judgment ||
          interpretJudgment(judgment, blocks, []).verdict === "uncertain") &&
        (!options.testOnly || review.independentReview)
      ) {
        // Parent owns llm.ts. Its sandboxed CLI adapter must assess the same full snapshot.
        try {
          const { judgeWithLlm } = await import("./llm");
          const raw: unknown = await timedJudge(
            () =>
              judgeWithLlm(
                {
                  newPost: {
                    title: input.title,
                    body: input.body,
                    tags: [...input.tags],
                  },
                  candidates: structuredClone(candidates),
                  matches: {
                    blocks,
                    atomicQuestions,
                    corpusHash: before,
                    requirements:
                      "Judge all disjoint blocks in full document context against the union. No meaningful novelty, unchanged conditions and complete no-space coverage are all required for duplicate. Padding, paraphrase, reordering and mosaics do not add contribution. Changed environments, new evidence, corrections and useful alternatives may add contribution. On ambiguity return uncertain.",
                  },
                },
                { independentReview: review.independentReview },
              ),
            150_000,
          );
          const result = raw as Record<string, unknown> | null;
          if (
            result &&
            [
              "distinct",
              "related",
              "overlap",
              "duplicate",
              "uncertain",
            ].includes(String(result.verdict)) &&
            Array.isArray(result.relatedPostIds) &&
            result.relatedPostIds.every(
              (id) =>
                typeof id === "string" && candidates.some((c) => c.id === id),
            ) &&
            typeof result.evidence === "string" &&
            result.evidence.trim().length > 0 &&
            Buffer.byteLength(result.evidence) <= 64_000 &&
            (result.verdict !== "duplicate" ||
              result.relatedPostIds.length > 0) &&
            (result.verdict !== "distinct" ||
              result.relatedPostIds.length === 0)
          ) {
            record(snapshot, {
              source: "codex-cli",
              evidence: result.evidence,
            });
            return finish({
              verdict: result.verdict as DuplicateAssessment["verdict"],
              relatedPostIds: [...new Set(result.relatedPostIds as string[])],
              evidence: result.evidence,
              corpusHash: before,
            });
          }
        } catch {
          /* Missing adapter, invalid output or CLI failure always remains uncertain. */
        }
      }
      record(snapshot, {
        source,
        embeddingFailure,
        answers: judgment?.evidence ?? null,
      });
      if (!judgment)
        return finish(
          uncertain(
            embeddingFailure
              ? "embedding-unavailable"
              : "judge-unavailable-or-invalid",
          ),
        );
      const decision = interpretJudgment(
        judgment,
        blocks,
        candidates.map((d) => d.id),
      );
      decision.evidence = JSON.stringify({
        reason: decision.evidence,
        source,
        answers: judgment.evidence,
        coverage: {
          total: blocks.reduce((s, b) => s + b.weight, 0),
          covered: blocks.reduce(
            (s, b, i) => s + (judgment.coverage[i] === "yes" ? b.weight : 0),
            0,
          ),
        },
        version: JUDGE_VERSION,
      });
      return finish(decision);
    } catch {
      return uncertain("comparison-unavailable-or-limit");
    }
  }
  async function relatedPublicPosts(
    postId: string,
    limit = 5,
  ): Promise<DuplicateAssessment> {
    try {
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.relatedLimit)
        return uncertain("invalid-limit");
      const before = hashPublicStore(store);
      const exists = store
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='duplicate_relations'",
        )
        .get();
      if (!exists)
        return {
          verdict: "distinct",
          relatedPostIds: [],
          evidence: "no-confirmed-relations",
          corpusHash: before,
        };
      const rows = store
        .prepare(
          `SELECT r.related_id,r.source_hash,r.target_hash,
        s.title source_title,s.body source_body,s.tags source_tags,
        t.title target_title,t.body target_body,t.tags target_tags
        FROM duplicate_relations r JOIN posts s ON s.id=r.post_id AND s.status='published'
        JOIN posts t ON t.id=r.related_id AND t.status='published'
        WHERE r.post_id=? ORDER BY r.related_id`,
        )
        .all(postId) as {
        related_id: string;
        source_hash: string;
        target_hash: string;
        source_title: string;
        source_body: string;
        source_tags: string;
        target_title: string;
        target_body: string;
        target_tags: string;
      }[];
      const ids = rows
        .filter(
          (r) =>
            documentHash({
              title: r.source_title,
              body: r.source_body,
              tags: JSON.parse(r.source_tags),
            }) === r.source_hash &&
            documentHash({
              title: r.target_title,
              body: r.target_body,
              tags: JSON.parse(r.target_tags),
            }) === r.target_hash,
        )
        .map((r) => r.related_id)
        .slice(0, limit);
      if (hashPublicStore(store) !== before)
        return { ...uncertain("public-corpus-changed"), corpusHash: before };
      return {
        verdict: ids.length ? "related" : "distinct",
        relatedPostIds: ids,
        evidence: "confirmed-semantic-relations",
        corpusHash: before,
      };
    } catch {
      return uncertain("related-unavailable-or-limit");
    }
  }
  function recordPublishedRelations(
    postId: string,
    relatedIds: string[],
    evidenceCorpus?: string,
  ): void {
    if (
      relatedIds.length > LIMITS.candidatePosts ||
      relatedIds.some((id) => typeof id !== "string" || id === postId)
    )
      throw new Error("invalid-confirmed-relations");
    store
      .transaction(() => {
        const source = store
          .prepare(
            "SELECT title,body,tags FROM posts WHERE id=? AND status='published'",
          )
          .get(postId) as
          { title: string; body: string; tags: string } | undefined;
        if (!source) throw new Error("relation-source-not-public");
        // Commit callers normally pass the prepublication assessment hash, which excludes this post.
        if (evidenceCorpus && hashPublicStore(store, postId) !== evidenceCorpus)
          throw new Error("relation-corpus-changed");
        const sourceHash = documentHash({
          ...source,
          tags: JSON.parse(source.tags),
        });
        store
          .prepare("DELETE FROM duplicate_relations WHERE post_id=?")
          .run(postId);
        for (const id of new Set(relatedIds)) {
          const target = store
            .prepare(
              "SELECT title,body,tags FROM posts WHERE id=? AND status='published'",
            )
            .get(id) as
            { title: string; body: string; tags: string } | undefined;
          if (!target) throw new Error("relation-target-not-public");
          store
            .prepare("INSERT INTO duplicate_relations VALUES(?,?,?,?,?)")
            .run(
              postId,
              id,
              sourceHash,
              documentHash({ ...target, tags: JSON.parse(target.tags) }),
              evidenceCorpus ?? null,
            );
        }
      })
      .immediate();
  }
  async function refreshDuplicateIndex(): Promise<{
    complete: boolean;
    corpusHash: string;
  }> {
    const all = documents();
    const before = corpusHash(all);
    try {
      const backend = await embeddings();
      for await (const _old of corpusVectors(all, backend)) {
        /* Streaming refresh; persistent progress survives an execution batch limit. */
      }
      return {
        complete: hashPublicStore(store) === before,
        corpusHash: before,
      };
    } catch {
      return { complete: false, corpusHash: before };
    }
  }
  return {
    assessDuplicate,
    relatedPublicPosts,
    publicCorpusHash: (excludePostId?: string) =>
      hashPublicStore(store, excludePostId),
    refreshDuplicateIndex,
    recordPublishedRelations,
  };
}

let configuredFallback: DuplicateFallback | undefined;
/** Parent can install a real CLI/accounted LLM adapter; no guessed API or mock fallback. */
export function configureDuplicateFallback(
  fallback: DuplicateFallback | undefined,
): void {
  configuredFallback = fallback;
}
export async function assessDuplicate(
  input: DuplicateInput,
  review: { independentReview?: boolean } = {},
): Promise<DuplicateAssessment> {
  // Headless integration fixtures exercise HTTP/session/UI flows separately
  // from the real retrieval/judge evaluation. Never available in production
  // or against the local preview/production database.
  const fixturePath = (process.env.DATABASE_PATH ?? "").replaceAll("\\", "/");
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.DUPLICATE_MOCK === "distinct" &&
    /\/data\/(?:e2e-[a-f0-9]+-(?:pass|hold|error)\.sqlite|ui-ux\/[a-z0-9-]+-\d+\.sqlite)$/.test(
      fixturePath,
    )
  )
    return {
      verdict: "distinct",
      relatedPostIds: [],
      evidence: "isolated-http-fixture",
      corpusHash: publicCorpusHash(input.excludePostId),
    };
  return createDuplicateDetector({
    fallback: configuredFallback,
  }).assessDuplicate(input, review);
}
export async function relatedPublicPosts(
  postId: string,
  limit = 5,
): Promise<DuplicateAssessment> {
  return createDuplicateDetector({ readOnly: true }).relatedPublicPosts(
    postId,
    limit,
  );
}

/** Parent may repeat this bounded local-only refresh until complete before bulk publication. */
export async function refreshDuplicateIndex(): Promise<{
  complete: boolean;
  corpusHash: string;
}> {
  return createDuplicateDetector().refreshDuplicateIndex();
}

/** Only call after a validated semantic assessment, inside the publication lease/commit. */
export function recordPublishedRelations(
  postId: string,
  relatedIds: string[],
  evidenceCorpus?: string,
): void {
  createDuplicateDetector().recordPublishedRelations(
    postId,
    relatedIds,
    evidenceCorpus,
  );
}
