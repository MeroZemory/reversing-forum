import "server-only";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Block, DuplicateInput, EmbeddingBackend } from "./types";

export const MODEL = "Xenova/multilingual-e5-small";
export const MODEL_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const DIMENSION = 384;
export const EMBEDDING_VERSION = "e5-fp32-mean-l2-context-v1";
let backend: Promise<EmbeddingBackend> | undefined;

/** Parent must pre-cache this immutable revision. This module never downloads weights. */
export function localEmbeddings(): Promise<EmbeddingBackend> {
  backend ??= (async () => {
    const revision = MODEL_REVISION;
    const { pipeline } = await import("@huggingface/transformers");
    const extractor = await pipeline("feature-extraction", MODEL, {
      device: "cpu",
      dtype: "fp32",
      revision,
      local_files_only: true,
      cache_dir: resolve("data/duplicates/models"),
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    });
    return {
      version: `${MODEL}:${revision}:${EMBEDDING_VERSION}`,
      async tokenCount(text: string) {
        const tokens = extractor.tokenizer(text, {
          truncation: false,
          padding: false,
        });
        return tokens.input_ids.size;
      },
      async embed(texts: string[]) {
        for (const text of texts) {
          if (
            extractor.tokenizer(text, { truncation: false, padding: false })
              .input_ids.size > 512
          )
            throw new Error("embedding-token-limit");
        }
        // The pipeline internally enables truncation. Verified <=512 input means it cannot cut content.
        const output = await extractor(texts, {
          pooling: "mean",
          normalize: true,
        });
        return output.tolist() as number[][];
      },
    };
  })().catch((error) => {
    backend = undefined;
    throw error;
  });
  return backend;
}

export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
// Deliberately preserve Unicode, case, punctuation, operators, constants and internal whitespace.
export const copyFingerprint = (text: string) =>
  hash(text.replace(/\r\n/g, "\n"));
export const noSpaceLength = (text: string) => text.replace(/\s/gu, "").length;

/** Disjoint UTF-16 offsets cover the entire original body; no contextual overlap is counted.
 * Conservative character splits are subsequently verified with the actual model tokenizer.
 * Recursive splitting guarantees no silent truncation, even for long code/no-space text. */
export async function splitBlocks(
  input: DuplicateInput,
  embeddings: EmbeddingBackend,
): Promise<Block[]> {
  const blocks: Block[] = [];
  async function add(start: number, end: number): Promise<void> {
    const text = input.body.slice(start, end);
    const heading =
      Array.from(input.body.slice(0, start).matchAll(/^#{1,6}\s+(.+)$/gm)).at(
        -1,
      )?.[1] ?? "";
    const context = [
      input.title.slice(0, 128),
      heading.slice(0, 96),
      input.tags.join(" ").slice(0, 96),
      input.body.slice(Math.max(0, start - 48), start),
      input.body.slice(end, end + 48),
    ].join("\n");
    const encoded = `passage: ${context}\n${text}`;
    if ((await embeddings.tokenCount(encoded)) > 512) {
      if (end - start <= 2) throw new Error("context-exceeds-token-limit");
      let mid = start + Math.floor((end - start) / 2);
      if (/[\uD800-\uDBFF]/.test(input.body[mid - 1])) mid++;
      await add(start, mid);
      await add(mid, end);
    } else {
      blocks.push({ start, end, text, context, weight: noSpaceLength(text) });
      if (blocks.length > 96) throw new Error("block-limit");
    }
  }
  for (let start = 0; start < input.body.length;) {
    let end = Math.min(start + 640, input.body.length);
    if (/[\uD800-\uDBFF]/.test(input.body[end - 1]) && end < input.body.length)
      end++;
    await add(start, end);
    start = end;
  }
  return blocks;
}

export function validVector(vector: unknown): vector is number[] {
  if (
    !Array.isArray(vector) ||
    vector.length !== DIMENSION ||
    !vector.every((v) => typeof v === "number" && Number.isFinite(v))
  )
    return false;
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return Math.abs(norm - 1) < 0.01;
}
export const cosine = (a: number[], b: number[]) =>
  a.reduce((sum, v, i) => sum + v * b[i], 0);
