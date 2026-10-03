import "server-only";
import { randomUUID } from "node:crypto";
import {
  reportReasons,
  type OperatorReport,
  type ReportReason,
} from "@/contracts/reports";
import { getViewer } from "./auth";
import { db } from "./db";
import { ForumError } from "./forum";

export function publicReportTarget(id: string) {
  return db
    .prepare("SELECT id,title FROM posts WHERE id=? AND status='published'")
    .get(id) as { id: string; title: string } | undefined;
}
export async function canReviewReports() {
  const user = await getViewer();
  return Boolean(
    user &&
    user.emailVerified &&
    process.env.EDITOR_USER_ID &&
    user.id === process.env.EDITOR_USER_ID,
  );
}
export async function submitReport(input: unknown) {
  const user = await getViewer();
  if (!user) throw new ForumError(401, "로그인 후 요청해 주세요.");
  if (!user.emailVerified)
    throw new ForumError(403, "이메일 인증을 완료해 주세요.");
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ForumError(400, "요청 내용을 확인해 주세요.");
  const data = input as Record<string, unknown>;
  if (
    Object.keys(data).some(
      (key) => !["postId", "reason", "detail"].includes(key),
    ) ||
    typeof data.reason !== "string" ||
    !Object.hasOwn(reportReasons, data.reason) ||
    typeof data.detail !== "string" ||
    data.detail.trim().length < 10 ||
    data.detail.length > 2000 ||
    (data.postId !== undefined &&
      (typeof data.postId !== "string" ||
        data.postId.length > 128 ||
        !data.postId))
  )
    throw new ForumError(400, "사유와 10~2,000자의 설명을 입력해 주세요.");
  const postId = data.postId as string | undefined;
  const reason = data.reason as ReportReason,
    detail = data.detail.trim();
  return db.transaction(() => {
    if (postId && !publicReportTarget(postId))
      throw new ForumError(404, "글을 찾을 수 없습니다.");
    const since = new Date(Date.now() - 3600_000).toISOString();
    const recent = db
      .prepare(
        "SELECT COUNT(*) AS total FROM reports WHERE reporter_id=? AND created_at>=?",
      )
      .get(user.id, since) as { total: number };
    if (recent.total >= 5)
      throw new ForumError(
        429,
        "한 시간에 최대 5건을 접수할 수 있습니다. 잠시 후 다시 요청해 주세요.",
      );
    db.prepare(
      "INSERT INTO reports(id,post_id,reporter_id,reason,detail,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      postId ?? null,
      user.id,
      reason,
      detail,
      new Date().toISOString(),
    );
    return { received: true };
  })();
}
export async function loadOperatorReports(): Promise<OperatorReport[]> {
  if (!(await canReviewReports()))
    throw new ForumError(403, "운영 권한이 필요합니다.");
  return db
    .prepare(
      `SELECT r.id,r.post_id AS postId,p.title AS postTitle,r.reason,r.detail,r.created_at AS createdAt
    FROM reports r LEFT JOIN posts p ON p.id=r.post_id AND p.status='published'
    ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,
    )
    .all() as OperatorReport[];
}
