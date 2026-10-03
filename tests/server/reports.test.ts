import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/types";
const current = vi.hoisted(() => ({ user: null as Viewer | null }));
vi.mock("@/server/auth", () => ({ getViewer: async () => current.user }));
let db: (typeof import("@/server/db"))["db"],
  reports: typeof import("@/server/reports"),
  post: typeof import("@/app/api/reports/route");
const saved = {
  database: process.env.DATABASE_PATH,
  editor: process.env.EDITOR_USER_ID,
  origin: process.env.BETTER_AUTH_URL,
};
const member = (id = "member"): Viewer => ({
  id,
  name: "검수회원",
  email: "synthetic@example.test",
  emailVerified: true,
});
const detail = "본문의 특정 내용에 개인정보가 남아 있어 삭제를 요청합니다.";
beforeAll(async () => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.EDITOR_USER_ID = "operator";
  process.env.BETTER_AUTH_URL = "https://forum.example.test";
  ({ db } = await import("@/server/db"));
  reports = await import("@/server/reports");
  post = await import("@/app/api/reports/route");
});
beforeEach(() => {
  current.user = member();
  db.exec("DELETE FROM reports; DELETE FROM posts;");
  const insert = db.prepare(
    "INSERT INTO posts(id,author_id,author_name,title,body,kind,tags,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  for (const status of ["published", "held", "pending"])
    insert.run(
      status,
      "author",
      "작성자",
      status === "published" ? "공개 글" : "비공개 제목",
      "본문",
      "question",
      "[]",
      status,
      new Date().toISOString(),
    );
});
afterAll(() => {
  db.close();
  for (const [key, value] of Object.entries({
    DATABASE_PATH: saved.database,
    EDITOR_USER_ID: saved.editor,
    BETTER_AUTH_URL: saved.origin,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const count = () =>
  (
    db.prepare("SELECT COUNT(*) AS total FROM reports").get() as {
      total: number;
    }
  ).total;
it("requires a verified server session before creating any report", async () => {
  current.user = null;
  await expect(
    reports.submitReport({ reason: "privacy", detail }),
  ).rejects.toMatchObject({ status: 401 });
  current.user = { ...member(), emailVerified: false };
  await expect(
    reports.submitReport({ reason: "privacy", detail }),
  ).rejects.toMatchObject({ status: 403 });
  expect(count()).toBe(0);
});
it("records a private request against the session identity and keeps the public post intact", async () => {
  expect(
    await reports.submitReport({
      postId: "published",
      reason: "privacy",
      detail,
    }),
  ).toEqual({ received: true });
  expect(
    db.prepare("SELECT reporter_id,reason,detail FROM reports").get(),
  ).toEqual({ reporter_id: "member", reason: "privacy", detail });
  expect(
    db.prepare("SELECT status FROM posts WHERE id='published'").get(),
  ).toEqual({ status: "published" });
  expect(await reports.submitReport({ reason: "copyright", detail })).toEqual({
    received: true,
  });
});
it.each([
  { reason: "privacy", detail, reporter_id: "operator" },
  { reason: "__proto__", detail },
  { reason: "spam", detail: "짧음" },
  { reason: "spam", detail: "x".repeat(2001) },
  { reason: "spam", detail, postId: [] },
  { reason: "spam", detail, postId: "" },
])(
  "rejects forged identity, unsupported reasons, unbounded text or invalid targets %#",
  async (input) => {
    await expect(reports.submitReport(input)).rejects.toMatchObject({
      status: 400,
    });
    expect(count()).toBe(0);
  },
);
it.each(["held", "pending", "missing"])(
  "does not disclose or accept a report target for %s",
  async (postId) => {
    expect(reports.publicReportTarget(postId)).toBeUndefined();
    await expect(
      reports.submitReport({ postId, reason: "spam", detail }),
    ).rejects.toMatchObject({ status: 404 });
    expect(count()).toBe(0);
  },
);
it("limits report flooding on the server without blocking another member", async () => {
  for (let i = 0; i < 5; i++)
    await reports.submitReport({ postId: "published", reason: "spam", detail });
  await expect(
    reports.submitReport({ reason: "privacy", detail }),
  ).rejects.toMatchObject({ status: 429 });
  current.user = member("other-member");
  await reports.submitReport({ reason: "privacy", detail });
  expect(count()).toBe(6);
});
it("keeps the inbox operator-only, including for a report's own author", async () => {
  await reports.submitReport({
    postId: "published",
    reason: "privacy",
    detail,
  });
  await expect(reports.loadOperatorReports()).rejects.toMatchObject({
    status: 403,
  });
  current.user = null;
  expect(await reports.canReviewReports()).toBe(false);
  await expect(reports.loadOperatorReports()).rejects.toMatchObject({
    status: 403,
  });
  current.user = member("operator");
  const inbox = await reports.loadOperatorReports();
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({
    postId: "published",
    reason: "privacy",
    detail,
  });
  expect(inbox[0]).not.toHaveProperty("email");
  db.prepare(
    "UPDATE posts SET status='held',title='바뀐 비공개 제목' WHERE id='published'",
  ).run();
  expect((await reports.loadOperatorReports())[0].postTitle).toBeNull();
});
it("rejects cross-site requests before saving and accepts a same-origin verified member", async () => {
  const request = (origin: string) =>
    new Request("https://forum.example.test/api/reports", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ reason: "privacy", detail }),
    });
  expect(
    (await post.POST(request("https://attacker.example.test"))).status,
  ).toBe(403);
  expect(count()).toBe(0);
  const response = await post.POST(request("https://forum.example.test"));
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ received: true });
  expect(count()).toBe(1);
});
