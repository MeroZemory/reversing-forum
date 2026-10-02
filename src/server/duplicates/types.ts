import type Database from "better-sqlite3";

export type DuplicateInput = {
  title: string;
  body: string;
  tags: string[];
  excludePostId?: string;
};
export type PublicDocument = {
  id: string;
  title: string;
  body: string;
  tags: string[];
};
export type Block = {
  start: number;
  end: number;
  text: string;
  context: string;
  weight: number;
};
export type Outcome =
  "distinct" | "related" | "overlap" | "duplicate" | "uncertain";
/** Server-only assessment. evidence must never be serialized into public post responses. */
export type DuplicateAssessment = {
  verdict: Outcome;
  relatedPostIds: string[];
  evidence: string;
  corpusHash: string;
};
export type Choice = "yes" | "no" | "uncertain";
export const atomicQuestions = [
  "sameconditions",
  "new_evidence",
  "correction",
  "answer_fulfills",
  "novel_synthesis",
  "no_meaningful_novelty",
  "related_topic",
] as const;
export type AtomicQuestion = (typeof atomicQuestions)[number];
export type Judgment = {
  answers: Record<AtomicQuestion, Choice>;
  coverage: Choice[];
  evidence: unknown;
  relatedIds?: string[];
};
/** One immutable full-text comparison of NEW against the retrieved union of full OLD texts.
 * corpusHash covers the entire published retrieval corpus, including unretrieved documents.
 * Fallback adapters must use an actual LLM, honor signal, and account for their own costs.
 * Return unknown: the module validates it just as strictly as Jev's output. */
export type ComparisonSnapshot = {
  version: string;
  corpusHash: string;
  input: DuplicateInput;
  candidates: PublicDocument[];
  blocks: Block[];
};
export type DuplicateFallback = (
  snapshot: ComparisonSnapshot,
  signal: AbortSignal,
) => Promise<unknown>;
export type EmbeddingBackend = {
  version: string;
  tokenCount(text: string): Promise<number>;
  embed(texts: string[]): Promise<number[][]>;
};
export type TestDependencies = {
  embeddings?: EmbeddingBackend;
  judge?: DuplicateFallback;
};
export type DetectorOptions = {
  store?: Database.Database;
  fallback?: DuplicateFallback;
  testOnly?: TestDependencies;
  readOnly?: boolean;
};
