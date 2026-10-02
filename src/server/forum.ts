import "server-only";
import { randomUUID } from "node:crypto";
import {
  getPostPurpose,
  postKinds,
  type Comment,
  type PostDetail,
  type PostKind,
  type PostPurpose,
  type PostSummary,
  type Viewer,
} from "@/lib/types";
import { db } from "./db";
import { screenPost } from "./jev";
import { editorialDisplayName } from "@/lib/editorial-labels";

export class ForumError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type Row = {
  id: string;
  author_id: string;
  author_name: string;
  title: string;
  body: string;
  kind: PostKind;
  tags: string;
  status: PostDetail["status"];
  created_at: string;
  comment_count: number;
  editorial_provenance?: string | null;
};
function postSelect(): string {
  const hasReceipts = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='editorial_receipts'",
    )
    .get();
  const fields =
    "p.id,p.author_id,p.author_name,p.title,p.body,p.kind,p.tags,p.status,p.created_at";
  return `SELECT ${fields}, (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS comment_count${hasReceipts ? ", r.provenance AS editorial_provenance" : ""} FROM posts p${hasReceipts ? " LEFT JOIN editorial_receipts r ON r.post_id=p.id AND p.status='published'" : ""}`;
}
function detail(r: Row): PostDetail {
  let editorial: PostDetail["editorial"];
  if (
    r.status === "published" &&
    r.author_id === process.env.EDITORIAL_AUTHOR_USER_ID &&
    r.editorial_provenance
  ) {
    try {
      const p = JSON.parse(r.editorial_provenance);
      if (
        (p.type === "chat-editorial" || p.type === "independent-guide") &&
        typeof p.period === "string" &&
        typeof p.verificationSummary === "string"
      ) {
        editorial = {
          sourceType: p.type,
          period: p.period,
          verificationSummary: p.verificationSummary,
        };
      }
    } catch {
      /* Invalid provenance cannot grant an editorial role. */
    }
  }
  return {
    id: r.id,
    title: r.title,
    excerpt: r.body.slice(0, 180),
    body: r.body,
    kind: r.kind,
    tags: JSON.parse(r.tags),
    status: r.status,
    author: editorial
      ? { id: r.author_id, name: editorialDisplayName(), role: "editor" }
      : { id: r.author_id, name: r.author_name },
    createdAt: r.created_at,
    commentCount: r.comment_count,
    ...(editorial ? { editorial } : {}),
  };
}
export function listPosts({
  query,
  kind,
  limit = 30,
}: { query?: string; kind?: PostKind; limit?: number } = {}): PostSummary[] {
  const clauses = ["p.status='published'"];
  const args: (string | number)[] = [];
  if (query?.trim()) {
    clauses.push(
      "(p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\' OR p.tags LIKE ? ESCAPE '\\')",
    );
    const term = `%${query
      .trim()
      .slice(0, 200)
      .replace(/[\\%_]/g, "\\$&")}%`;
    args.push(term, term, term);
  }
  if (kind) {
    clauses.push("p.kind=?");
    args.push(kind);
  }
  args.push(
    Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 30,
  );
  return (
    db
      .prepare(
        `${postSelect()} WHERE ${clauses.join(" AND ")} ORDER BY p.created_at DESC, p.id LIMIT ?`,
      )
      .all(...args) as Row[]
  ).map((r) => {
    const {
      body: _body,
      status: _status,
      editorial: _editorial,
      ...summary
    } = detail(r);
    return summary;
  });
}
export function listPostPage({
  query,
  purpose,
  tag,
  page = 1,
  pageSize = 30,
}: {
  query?: string;
  purpose?: PostPurpose;
  tag?: string;
  page?: number;
  pageSize?: number;
} = {}): {
  posts: PostSummary[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
} {
  const clauses = ["p.status='published'"];
  const args: (string | number)[] = [];
  if (query?.trim()) {
    clauses.push(
      "(p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\' OR p.tags LIKE ? ESCAPE '\\')",
    );
    const term = `%${query
      .trim()
      .slice(0, 200)
      .replace(/[\\%_]/g, "\\$&")}%`;
    args.push(term, term, term);
  }
  if (purpose) {
    const kinds = postKinds.filter((kind) => getPostPurpose(kind) === purpose);
    clauses.push(`p.kind IN (${kinds.map(() => "?").join(",") || "NULL"})`);
    args.push(...kinds);
  }
  if (tag?.trim()) {
    clauses.push(
      "EXISTS (SELECT 1 FROM json_each(p.tags) t WHERE t.type='text' AND t.value = ? COLLATE NOCASE)",
    );
    args.push(tag.trim());
  }
  const where = clauses.join(" AND ");
  const size = Number.isFinite(pageSize)
    ? Math.max(1, Math.min(100, Math.trunc(pageSize)))
    : 30;
  // Keep the count and page in the same read snapshot.
  return db.transaction(() => {
    const { total } = db
      .prepare(`SELECT COUNT(*) AS total FROM posts p WHERE ${where}`)
      .get(...args) as { total: number };
    const pageCount = Math.max(1, Math.ceil(total / size));
    const currentPage = Number.isFinite(page)
      ? Math.max(1, Math.min(pageCount, Math.trunc(page)))
      : 1;
    const posts = (
      db
        .prepare(
          `${postSelect()} WHERE ${where} ORDER BY p.created_at DESC, p.id LIMIT ? OFFSET ?`,
        )
        .all(...args, size, (currentPage - 1) * size) as Row[]
    ).map((r) => {
      const {
        body: _body,
        status: _status,
        editorial: _editorial,
        ...summary
      } = detail(r);
      return summary;
    });
    return { posts, total, page: currentPage, pageSize: size, pageCount };
  })();
}

export function listPublicTopics(limit = 20): { tag: string; count: number }[] {
  const size = Number.isFinite(limit)
    ? Math.max(1, Math.min(100, Math.trunc(limit)))
    : 20;
  return db
    .prepare(
      `SELECT MIN(t.value) AS tag, COUNT(DISTINCT p.id) AS count
       FROM posts p, json_each(p.tags) t
       WHERE p.status='published' AND t.type='text' AND trim(t.value)<>''
       GROUP BY t.value COLLATE NOCASE
       ORDER BY count DESC, tag COLLATE NOCASE, tag
       LIMIT ?`,
    )
    .all(size) as { tag: string; count: number }[];
}

export function listMyPosts(userId: string): PostDetail[] {
  return (
    db
      .prepare(
        `${postSelect()} WHERE p.author_id=? ORDER BY p.created_at DESC, p.id`,
      )
      .all(userId) as Row[]
  ).map(detail);
}
export function getPost(id: string, viewerId?: string): PostDetail | null {
  const row = db
    .prepare(
      `${postSelect()} WHERE p.id=? AND (p.status='published' OR p.author_id=?)`,
    )
    .get(id, viewerId ?? "") as Row | undefined;
  return row ? detail(row) : null;
}
export function listComments(postId: string): Comment[] {
  const rows = db
    .prepare(
      `SELECT c.* FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.post_id=? AND p.status='published' ORDER BY c.created_at,c.id`,
    )
    .all(postId) as {
    id: string;
    post_id: string;
    parent_id: string | null;
    author_id: string;
    author_name: string;
    body: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    postId: r.post_id,
    parentId: r.parent_id,
    author: { id: r.author_id, name: r.author_name },
    body: r.body,
    createdAt: r.created_at,
  }));
}
function text(value: unknown, min: number, max: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > max
  )
    throw new ForumError(
      400,
      `${label}: ${min}~${max}자 범위로 입력해 주세요.`,
    );
  return value.trim();
}
function member(viewer: Viewer | null): Viewer {
  if (!viewer?.id) throw new ForumError(401, "로그인이 필요합니다.");
  return viewer;
}
function flood(
  table: "posts" | "comments",
  userId: string,
  seconds: number,
  minuteLimit: number,
) {
  const latest = db
    .prepare(
      `SELECT created_at FROM ${table} WHERE author_id=? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId) as { created_at: string } | undefined;
  const count = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE author_id=? AND created_at>?`,
    )
    .get(userId, new Date(Date.now() - 60_000).toISOString()) as { n: number };
  if (
    (latest && Date.now() - Date.parse(latest.created_at) < seconds * 1000) ||
    count.n >= minuteLimit
  )
    throw new ForumError(429, "잠시 후 다시 작성해 주세요.");
}
export async function createPost(
  viewer: Viewer | null,
  input: unknown,
): Promise<{ id: string; status: PostDetail["status"] }> {
  const user = member(viewer);
  if (!input || typeof input !== "object")
    throw new ForumError(400, "잘못된 요청입니다.");
  const data = input as Record<string, unknown>;
  const title = text(data.title, 2, 160, "제목");
  const body = text(data.body, 10, 30_000, "본문");
  if (!postKinds.includes(data.kind as PostKind))
    throw new ForumError(400, "글 종류를 확인해 주세요.");
  if (!Array.isArray(data.tags) || data.tags.length > 5)
    throw new ForumError(400, "태그는 최대 5개입니다.");
  const tags = [...new Set(data.tags.map((t) => text(t, 1, 24, "태그")))];
  const id = randomUUID();
  db.transaction(() => {
    flood("posts", user.id, 30, 2);
    db.prepare(
      "INSERT INTO posts(id,author_id,author_name,title,body,kind,tags,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)",
    ).run(
      id,
      user.id,
      user.name,
      title,
      body,
      data.kind as string,
      JSON.stringify(tags),
      new Date().toISOString(),
    );
  }).immediate();
  const screening = await screenPost(
    JSON.stringify({ title, body, kind: data.kind, tags }),
  );
  db.prepare(
    "UPDATE posts SET status=?,screening_evidence=? WHERE id=? AND status='pending'",
  ).run(screening.status, screening.evidence, id);
  return { id, status: screening.status };
}
export function createComment(
  viewer: Viewer | null,
  postId: string,
  input: unknown,
): Comment {
  const user = member(viewer);
  if (!input || typeof input !== "object")
    throw new ForumError(400, "잘못된 요청입니다.");
  const data = input as Record<string, unknown>;
  const body = text(data.body, 1, 2000, "댓글");
  const parentId = data.parentId ?? null;
  if (parentId !== null && (typeof parentId !== "string" || !parentId.length))
    throw new ForumError(400, "잘못된 상위 댓글입니다.");
  return db
    .transaction(() => {
      const post = db
        .prepare("SELECT id FROM posts WHERE id=? AND status='published'")
        .get(postId);
      if (!post) throw new ForumError(404, "글을 찾을 수 없습니다.");
      if (parentId) {
        const parent = db
          .prepare(
            "SELECT id FROM comments WHERE id=? AND post_id=? AND parent_id IS NULL",
          )
          .get(parentId, postId);
        if (!parent)
          throw new ForumError(
            400,
            "같은 글의 원댓글에만 답글을 작성할 수 있습니다.",
          );
      }
      flood("comments", user.id, 5, 6);
      const comment: Comment = {
        id: randomUUID(),
        postId,
        parentId: parentId as string | null,
        author: { id: user.id, name: user.name },
        body,
        createdAt: new Date().toISOString(),
      };
      db.prepare(
        "INSERT INTO comments(id,post_id,parent_id,author_id,author_name,body,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        comment.id,
        postId,
        comment.parentId,
        user.id,
        user.name,
        body,
        comment.createdAt,
      );
      return comment;
    })
    .immediate();
}
