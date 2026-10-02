import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { PostStatus } from "@/lib/types";
import { db } from "./db";
import { screenPost } from "./jev";
import { assessDuplicate, publicCorpusHash } from "./duplicates/index";

let initialized = false;
// Initialize on writes; importing a read-only forum must not mutate storage.
export function initPublicationTables() {
  if (initialized) return;
  db.exec(`
  CREATE TABLE IF NOT EXISTS publication_lease (
    id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS publication_limits (
    scope TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS publication_attempts (
    request_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS post_payloads (
    author_id TEXT NOT NULL, payload_hash TEXT NOT NULL, body_hash TEXT NOT NULL,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    PRIMARY KEY(author_id,payload_hash)
  );
  CREATE INDEX IF NOT EXISTS post_payloads_body ON post_payloads(author_id,body_hash);
`);
  initialized = true;
}

export const payloadHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const reasonCodes = [
  "pending",
  "published",
  "minimum_held",
  "duplicate",
  "duplicate_uncertain",
  "publication_busy",
  "attempt_limit",
  "global_call_limit",
  "unavailable",
  "input_too_large",
  "screening_timeout",
  "lease_lost",
  "corpus_changed",
  "corpus_unavailable",
  "missing_corpus_hash",
  "budget_exhausted",
  "missing_key",
  "api_error",
  "invalid_response",
  "unverified_usage_or_model",
] as const;
export type PublicationNotice = {
  reasonCode: (typeof reasonCodes)[number];
  relatedPublishedIds: string[];
  canRetry: boolean;
  // The owner can request a bounded independent full-snapshot comparison.
  canRequestReview: boolean;
};

/** Owner-only projection. No raw judge evidence, excerpts, hashes or private IDs. */
export function getPublicationNotice(
  postId: string,
  viewerId: string,
): PublicationNotice | null {
  if (!viewerId) return null;
  const row = db
    .prepare(
      "SELECT title,body,kind,tags,status,screening_evidence FROM posts WHERE id=? AND author_id=?",
    )
    .get(postId, viewerId) as
    | {
        title: string;
        body: string;
        kind: string;
        tags: string;
        status: PostStatus;
        screening_evidence: string | null;
      }
    | undefined;
  if (!row) return null;
  let evidence: {
    reason?: string;
    duplicate?: { verdict?: string; relatedPostIds?: unknown[] };
    jev?: string;
  } = {};
  try {
    evidence = JSON.parse(row.screening_evidence ?? "{}") ?? {};
  } catch {
    /* No raw fallback. */
  }
  const duplicate = evidence.duplicate?.verdict === "duplicate";
  let reasonCode: PublicationNotice["reasonCode"] =
    row.status === "published"
      ? "published"
      : row.status === "held"
        ? "minimum_held"
        : "pending";
  if (row.status !== "published") {
    if (duplicate) reasonCode = "duplicate";
    else if (evidence.duplicate?.verdict === "uncertain")
      reasonCode = "duplicate_uncertain";
    else if (
      reasonCodes.includes(evidence.reason as PublicationNotice["reasonCode"])
    )
      reasonCode = evidence.reason as PublicationNotice["reasonCode"];
    else {
      try {
        const jev = JSON.parse(evidence.jev ?? "{}");
        if (reasonCodes.includes(jev.reason)) reasonCode = jev.reason;
      } catch {
        /* Keep the safe generic status. */
      }
    }
  }
  const relatedPublishedIds = [
    ...new Set(
      Array.isArray(evidence.duplicate?.relatedPostIds)
        ? evidence.duplicate.relatedPostIds
        : [],
    ),
  ]
    .slice(0, 20)
    .filter(
      (id): id is string =>
        typeof id === "string" &&
        id !== postId &&
        Boolean(
          db
            .prepare("SELECT 1 FROM posts WHERE id=? AND status='published'")
            .get(id),
        ),
    );
  let canRetry = false;
  let canRequestReview = false;
  const tables = db
    .prepare(
      "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('post_payloads','publication_attempts','publication_limits')",
    )
    .get() as { n: number };
  if (tables.n === 3 && row.status !== "published") {
    try {
      const hash = payloadHash({
        title: row.title,
        body: row.body,
        kind: row.kind,
        tags: JSON.parse(row.tags),
      });
      const receipt = db
        .prepare(
          "SELECT 1 FROM post_payloads WHERE author_id=? AND post_id=? AND payload_hash=?",
        )
        .get(viewerId, postId, hash);
      const attempts = db
        .prepare(
          "SELECT attempts FROM publication_attempts WHERE request_key=?",
        )
        .get(`post:${postId}:${hash}`) as { attempts: number } | undefined;
      const limit = db
        .prepare(
          "SELECT window_start,attempts FROM publication_limits WHERE scope=?",
        )
        .get(`author:${viewerId}`) as
        { window_start: number; attempts: number } | undefined;
      canRetry =
        row.status === "pending" &&
        Boolean(receipt) &&
        (attempts?.attempts ?? 0) < 3 &&
        (!limit ||
          Date.now() - limit.window_start >= 60_000 ||
          limit.attempts < 10);
      const reviewAttempt = db
        .prepare(
          "SELECT attempts FROM publication_attempts WHERE request_key=?",
        )
        .get(`review:${postId}:${hash}`) as { attempts: number } | undefined;
      canRequestReview =
        row.status === "held" &&
        duplicate &&
        Boolean(receipt) &&
        (reviewAttempt?.attempts ?? 0) < 1;
    } catch {
      /* Invalid stored snapshots cannot grant retry permission. */
    }
  }
  return {
    reasonCode,
    relatedPublishedIds,
    canRetry,
    canRequestReview,
  };
}

/** Call before throwing on a rejected write, outside a transaction that rolls back. */
export function allowWriteAttempt(authorId: string): boolean {
  initPublicationTables();
  return db
    .transaction(() => consume(`author:${authorId}`, 60_000, 10))
    .immediate();
}

function consume(scope: string, window: number, limit: number): boolean {
  const now = Date.now();
  const row = db
    .prepare(
      "SELECT window_start,attempts FROM publication_limits WHERE scope=?",
    )
    .get(scope) as { window_start: number; attempts: number } | undefined;
  const fresh = !row || now - row.window_start >= window;
  const attempts = fresh ? 0 : row.attempts;
  db.prepare(
    `INSERT INTO publication_limits(scope,window_start,attempts) VALUES(?,?,?)
    ON CONFLICT(scope) DO UPDATE SET window_start=excluded.window_start,attempts=excluded.attempts`,
  ).run(
    scope,
    fresh ? now : row.window_start,
    Math.min(attempts + 1, limit + 1),
  );
  return attempts < limit;
}

export type PublicationResult = {
  status: PostStatus;
  evidence: string;
  relatedPublishedIds?: string[];
  corpusHash?: string;
};
type Options = {
  key: string;
  // Only the authenticated editorial publisher chooses the editorial lane.
  lane?: "member" | "editorial";
  // The complete immutable public payload, including editorial provenance.
  snapshot: { title: string; body: string; tags: string[] };
  excludePostId?: string;
  independentReview?: boolean;
};
const pending = (reason: string): PublicationResult => ({
  status: "pending",
  evidence: JSON.stringify({ reason }),
});
const ttl = 150_000;

/** commit runs synchronously inside the same SQLite transaction as token/corpus checks.
 * revalidate may check a real session after asynchronous screening (editorial).
 * No result cache: exact create retries use their immutable post_payloads receipt.
 */
export async function controlPublication<T>(
  options: Options,
  commit: (result: PublicationResult) => T,
  revalidate?: () => Promise<void>,
): Promise<T> {
  initPublicationTables();
  const token = randomUUID();
  const reason = db
    .transaction(() => {
      const lease = db
        .prepare("SELECT expires_at FROM publication_lease WHERE id=1")
        .get() as { expires_at: number } | undefined;
      if (lease && lease.expires_at > Date.now()) return "publication_busy";
      const attempts = db
        .prepare(
          "SELECT attempts FROM publication_attempts WHERE request_key=?",
        )
        .get(options.key) as { attempts: number } | undefined;
      if ((attempts?.attempts ?? 0) >= (options.independentReview ? 1 : 3))
        return "attempt_limit";
      const lane = options.lane ?? "member";
      if (
        !consume(`${lane}:minute`, 60_000, lane === "editorial" ? 120 : 6) ||
        !consume(`${lane}:hour`, 3_600_000, lane === "editorial" ? 2000 : 60)
      )
        return "global_call_limit";
      db.prepare(
        `INSERT INTO publication_attempts(request_key,attempts) VALUES(?,1)
      ON CONFLICT(request_key) DO UPDATE SET attempts=attempts+1`,
      ).run(options.key);
      db.prepare(
        `INSERT INTO publication_lease(id,token,expires_at) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at`,
      ).run(token, Date.now() + ttl);
      return null;
    })
    .immediate();

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let corpusHash: string | undefined;
  let result = reason ? pending(reason) : pending("unavailable");
  try {
    if (!reason) {
      heartbeat = setInterval(() => {
        try {
          db.prepare(
            "UPDATE publication_lease SET expires_at=? WHERE id=1 AND token=? AND expires_at>?",
          ).run(Date.now() + ttl, token, Date.now());
        } catch {
          /* A failed heartbeat expires; final token checks fail closed. */
        }
      }, 10_000);
      heartbeat.unref();
      const work = (async (): Promise<PublicationResult> => {
        const state = JSON.stringify(options.snapshot);
        if (Buffer.byteLength(state, "utf8") > 128_000)
          return pending("input_too_large");
        const duplicate = await assessDuplicate(
          {
            title: options.snapshot.title,
            body: options.snapshot.body,
            tags: options.snapshot.tags,
            excludePostId: options.excludePostId,
          },
          { independentReview: options.independentReview },
        );
        corpusHash = duplicate.corpusHash;
        // Only public IDs may be retained as owner-facing related references.
        const relatedPostIds = [...new Set(duplicate.relatedPostIds)].filter(
          (id) =>
            id !== options.excludePostId &&
            Boolean(
              db
                .prepare(
                  "SELECT 1 FROM posts WHERE id=? AND status='published'",
                )
                .get(id),
            ),
        );
        const evidence = {
          duplicate: {
            verdict: duplicate.verdict,
            relatedPostIds,
            evidence: duplicate.evidence,
            corpusHash,
          },
        };
        if (duplicate.verdict === "duplicate")
          return { status: "held", evidence: JSON.stringify(evidence) };
        if (!["distinct", "related", "overlap"].includes(duplicate.verdict))
          return { status: "pending", evidence: JSON.stringify(evidence) };
        if (
          timedOut ||
          !db
            .prepare(
              "SELECT 1 FROM publication_lease WHERE id=1 AND token=? AND expires_at>?",
            )
            .get(token, Date.now())
        )
          return pending("lease_lost");
        const jev = await screenPost(state);
        let status = jev.status;
        if (status === "held") {
          try {
            const details = JSON.parse(jev.evidence);
            // Jev's minimum gate also holds uncertainty; leave it retryable.
            if (
              details.reason === "invalid_response" ||
              (details.answers &&
                !Object.values(details.answers).some((answer) => {
                  if (!answer || typeof answer !== "object") return false;
                  const a = answer as Record<string, unknown>;
                  const p = a.probabilities as
                    Record<string, unknown> | undefined;
                  return (
                    a.type === "choice" &&
                    a.choice === "violation" &&
                    typeof a.confidence === "number" &&
                    a.confidence >= 0.9 &&
                    a.confidence <= 1 &&
                    p &&
                    ["allowed", "violation", "uncertain"].every(
                      (k) =>
                        typeof p[k] === "number" &&
                        Number.isFinite(p[k]) &&
                        (p[k] as number) >= 0 &&
                        (p[k] as number) <= 1,
                    ) &&
                    (p.violation as number) >= 0.9 &&
                    Math.abs(
                      (p.allowed as number) +
                        (p.violation as number) +
                        (p.uncertain as number) -
                        1,
                    ) <= 0.02
                  );
                }))
            )
              status = "pending";
          } catch {
            /* Evidence is private; the typed Jev gate owns its format. */
          }
        }
        return {
          status,
          evidence: JSON.stringify({ ...evidence, jev: jev.evidence }),
          relatedPublishedIds: relatedPostIds,
          corpusHash,
        };
      })();
      result = await Promise.race([
        work.catch(() => pending("unavailable")),
        new Promise<PublicationResult>((resolve) => {
          deadline = setTimeout(
            () => {
              timedOut = true;
              resolve(pending("screening_timeout"));
              // Member requests leave proxy response headroom; slower comparisons
              // stay private. Editorial HTTP callers allow 150s including response.
            },
            options.lane === "editorial" ? 120_000 : 110_000,
          );
        }),
      ]);
      clearTimeout(deadline);
    }
    await revalidate?.();
    return db
      .transaction(() => {
        if (!reason) {
          const live = db
            .prepare(
              "SELECT 1 FROM publication_lease WHERE id=1 AND token=? AND expires_at>?",
            )
            .get(token, Date.now());
          if (!live) result = pending("lease_lost");
          else {
            try {
              if (
                corpusHash &&
                publicCorpusHash(options.excludePostId) !== corpusHash
              )
                result = pending("corpus_changed");
              else if (result.status !== "pending" && !corpusHash)
                result = pending("missing_corpus_hash");
            } catch {
              result = pending("corpus_unavailable");
            }
          }
        }
        return commit(result);
      })
      .immediate();
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
    // A timed-out provider may still be running. Quarantine its slot until TTL;
    // it has no commit callback and its token cannot authorize a later write.
    if (!reason && !timedOut)
      db.prepare("DELETE FROM publication_lease WHERE id=1 AND token=?").run(
        token,
      );
  }
}
