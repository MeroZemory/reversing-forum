import { copyFingerprint, cosine } from "./embedding";
import type { Block, DuplicateInput, PublicDocument } from "./types";

// Bump this static version when retrieval behavior changes.
export const RETRIEVAL_VERSION = "block-union-v1";
type Cached = {
  document: PublicDocument;
  blocks: Block[];
  vectors: number[][];
};

function lexicalTerms(text: string): Set<string> {
  // No lowercasing or punctuation stripping: == vs !=, x64 vs X64, 0x10 vs 0x20 survive.
  return new Set(text.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}\s]+/gu) ?? []);
}

/** Ranking only: union per-block neighbours, copy fingerprints and document lexical hits.
 * No cosine threshold (or average) can prove a block is redundant. */
export function retrieveCandidateUnion(
  input: DuplicateInput,
  blocks: Block[],
  vectors: number[][],
  corpus: Cached[],
): string[] {
  const retriever = candidateRetriever(input, blocks, vectors);
  for (const old of corpus) retriever.visit(old);
  return retriever.result();
}

/** Constant vector working set: keep only three distinct old documents per NEW block.
 * Every public document is visited; older batches cannot fall outside a recent-post window. */
export function candidateRetriever(
  input: DuplicateInput,
  blocks: Block[],
  vectors: number[][],
) {
  const ids = new Set<string>();
  const rank = new Map<string, number>();
  const neighbours = vectors.map(() => [] as { id: string; score: number }[]);
  const lexical: { id: string; score: number }[] = [];
  const terms = lexicalTerms(
    [input.title, input.body, ...input.tags].join("\n"),
  );
  const copies = new Set(
    blocks.filter((b) => b.weight >= 60).map((b) => copyFingerprint(b.text)),
  );
  const bodyCopy = copyFingerprint(input.body);
  const keep = (
    hits: { id: string; score: number }[],
    hit: { id: string; score: number },
    limit: number,
  ) => {
    hits.push(hit);
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    if (hits.length > limit) hits.length = limit;
  };
  const add = (id: string, score: number) => {
    ids.add(id);
    rank.set(id, Math.max(rank.get(id) ?? 0, score));
  };
  function visit(old: Cached) {
    if (bodyCopy === copyFingerprint(old.document.body))
      add(old.document.id, 3);
    const oldCopies = new Set(
      old.blocks
        .filter((b) => b.weight >= 60)
        .map((b) => copyFingerprint(b.text)),
    );
    if ([...copies].some((fingerprint) => oldCopies.has(fingerprint)))
      add(old.document.id, 2);
    for (let i = 0; i < vectors.length; i++) {
      let score = -Infinity;
      for (const oldVector of old.vectors)
        score = Math.max(score, cosine(vectors[i], oldVector));
      if (Number.isFinite(score))
        keep(neighbours[i], { id: old.document.id, score }, 3);
    }
    const other = lexicalTerms(
      [old.document.title, old.document.body, ...old.document.tags].join("\n"),
    );
    const score =
      [...terms].filter((t) => other.has(t)).length / Math.max(1, terms.size);
    if (score > 0) keep(lexical, { id: old.document.id, score }, 5);
  }
  function result() {
    for (const hits of neighbours)
      for (const hit of hits) add(hit.id, hit.score);
    for (const hit of lexical) add(hit.id, hit.score);
    return [...ids].sort(
      (a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0) || a.localeCompare(b),
    );
  }
  return { visit, result };
}
