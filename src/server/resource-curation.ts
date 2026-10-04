import "server-only";
import { createHash } from "node:crypto";
import { getViewer } from "./auth";
import { db } from "./db";
import { ForumError } from "./forum";
import {
  curatedPostIds,
  eligibleResourceGuides,
  type ResourceSelection,
} from "./resources";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stale = () => new ForumError(409, "현재 공개본을 다시 확인해 주세요.");

// Lazy migration: importing the pure guide mapper never opens this store.
function store() {
  db.exec(`CREATE TABLE IF NOT EXISTS resource_curation (
    post_id TEXT PRIMARY KEY REFERENCES posts(id), hash TEXT NOT NULL,
    version TEXT NOT NULL, guides TEXT NOT NULL, actor_id TEXT NOT NULL,
    curated_at TEXT NOT NULL
  )`);
}

function publicSnapshot(postId: string) {
  const post = db
    .prepare(
      "SELECT id,title,body,kind,tags,author_id,created_at FROM posts WHERE id=? AND status='published'",
    )
    .get(postId) as
    | {
        id: string;
        title: string;
        body: string;
        kind: string;
        tags: string;
        author_id: string;
        created_at: string;
      }
    | undefined;
  if (!post) throw new ForumError(404, "공개 글을 찾을 수 없습니다.");
  const receipt = db
    .prepare(
      `SELECT r.revision,r.hash,r.provenance,p.versions
    FROM editorial_receipts r JOIN editorial_publications p
    ON p.candidate_key=r.candidate_key AND p.revision=r.revision
    WHERE r.post_id=?`,
    )
    .get(postId) as
    | { revision: number; hash: string; provenance: string; versions: string }
    | undefined;
  const payload = {
    ...post,
    tags: JSON.parse(post.tags),
    provenance: receipt ? JSON.parse(receipt.provenance) : null,
  };
  // A receipt alone cannot authorize a different stored public payload.
  // Editorial storage keeps questions and maps shares to the legacy analysis kind.
  if (
    receipt &&
    (!["analysis", "question"].includes(post.kind) ||
      digest({
        title: post.title,
        body: post.body,
        kind: post.kind === "question" ? "question" : "share",
        tags: payload.tags,
        provenance: payload.provenance,
      }) !== receipt.hash)
  )
    throw stale();
  const hash = digest(payload);
  return {
    postId,
    hash,
    version: digest([hash, receipt ?? null]),
    eligibleGuides: eligibleResourceGuides(payload),
    editorial: receipt
      ? {
          hash: receipt.hash,
          revision: receipt.revision,
          ...JSON.parse(receipt.versions),
        }
      : null,
  };
}

async function editor() {
  const user = await getViewer();
  if (!user) throw new ForumError(401, "로그인이 필요합니다.");
  // Same authority as editorial.editor(); the author role grants no permission.
  if (!process.env.EDITOR_USER_ID || user.id !== process.env.EDITOR_USER_ID)
    throw new ForumError(403, "편집 권한이 필요합니다.");
  return user;
}

export async function resourceCurationAction(input: unknown) {
  const user = await editor();
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ForumError(400, "올바른 요청을 입력해 주세요.");
  const data = input as Record<string, unknown>;
  if (
    !["snapshot", "select"].includes(data.action as string) ||
    typeof data.postId !== "string" ||
    !data.postId.length ||
    data.postId.length > 128 ||
    Object.keys(data).some(
      (key) =>
        !(
          data.action === "snapshot"
            ? ["action", "postId"]
            : ["action", "postId", "hash", "version", "guides"]
        ).includes(key),
    )
  )
    throw new ForumError(400, "허용된 필드를 확인해 주세요.");
  const postId = data.postId;
  if (data.action === "snapshot") return publicSnapshot(postId);
  store();
  return db
    .transaction(() => {
      const snapshot = publicSnapshot(postId);
      if (data.hash !== snapshot.hash || data.version !== snapshot.version)
        throw stale();
      const guides = data.guides ?? snapshot.eligibleGuides;
      if (
        !Array.isArray(guides) ||
        !guides.length ||
        guides.some(
          (guide) =>
            typeof guide !== "string" ||
            !snapshot.eligibleGuides.includes(guide),
        )
      )
        throw new ForumError(
          400,
          "이 공개 글에 맞는 안내 주제를 선택해 주세요.",
        );
      const selected = [...new Set(guides as string[])].sort();
      db.prepare(
        `INSERT INTO resource_curation(post_id,hash,version,guides,actor_id,curated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(post_id) DO UPDATE SET hash=excluded.hash,
      version=excluded.version,guides=excluded.guides,actor_id=excluded.actor_id,curated_at=excluded.curated_at`,
      ).run(
        postId,
        snapshot.hash,
        snapshot.version,
        JSON.stringify(selected),
        user.id,
        new Date().toISOString(),
      );
      return { ...snapshot, guides: selected, curated: true };
    })
    .immediate();
}

// Explicit live selection for resourceGuides(posts, currentResourceSelection()).
// Rechecking public state and version removes withdrawn or changed snapshots.
export function currentResourceSelection(): ResourceSelection {
  store();
  return db.transaction(() => {
    const selected = new Map<string, readonly string[]>();
    for (const id of curatedPostIds) {
      try {
        selected.set(id, publicSnapshot(id).eligibleGuides);
      } catch (error) {
        if (!(error instanceof ForumError && [404, 409].includes(error.status)))
          throw error;
      }
    }
    const rows = db.prepare("SELECT * FROM resource_curation").all() as {
      post_id: string;
      hash: string;
      version: string;
      guides: string;
    }[];
    for (const row of rows) {
      // An explicit record supersedes an initial seed, even when stale.
      selected.delete(row.post_id);
      try {
        const snapshot = publicSnapshot(row.post_id);
        if (row.hash === snapshot.hash && row.version === snapshot.version)
          selected.set(row.post_id, JSON.parse(row.guides));
      } catch (error) {
        if (!(error instanceof ForumError && [404, 409].includes(error.status)))
          throw error;
      }
    }
    return selected;
  })();
}
