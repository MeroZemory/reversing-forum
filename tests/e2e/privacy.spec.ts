import { test, expect } from "@playwright/test";
import { register, post } from "./helpers";
import Database from "better-sqlite3";
import { basename, dirname, resolve } from "node:path";

const createdPostIds: string[] = [];
test.afterEach(async ({}, info) => {
  if (!createdPostIds.length) return;
  const databasePath = String(info.project.metadata.databasePath);
  expect(dirname(databasePath)).toBe(resolve("data"));
  expect(basename(databasePath)).toMatch(
    /^e2e-[a-f0-9]+-(hold|error)\.sqlite$/,
  );
  const db = new Database(databasePath);
  try {
    db.transaction(() => {
      for (const id of createdPostIds) {
        db.prepare("DELETE FROM comments WHERE post_id=?").run(id);
        db.prepare("DELETE FROM posts WHERE id=?").run(id);
      }
    })();
  } finally {
    createdPostIds.length = 0;
    db.close();
  }
});

test("보류·API 오류 글을 작성자 외에 노출하지 않는다", async ({
  request,
  page,
  playwright,
  baseURL,
}, info) => {
  const origin = baseURL!;
  await register(request, origin);
  const { response, result } = await post(
    request,
    origin,
    `비공개 검수 글 ${info.project.name}`,
  );
  createdPostIds.push(result.id);
  expect(response.status()).toBe(202);
  expect(result.status).toBe(info.project.name === "hold" ? "held" : "pending");
  const own = await request.get(`/api/posts/${result.id}`);
  expect(own.status()).toBe(200);
  expect(await own.text()).not.toContain("screening_evidence");
  const ownSession = await request.storageState();
  await page.context().addCookies(ownSession.cookies);
  await page.goto(`/posts/${result.id}`);
  await expect(
    page.getByRole("heading", { name: `비공개 검수 글 ${info.project.name}` }),
  ).toBeVisible();
  const label = result.status === "held" ? "공개 보류" : "공개 전 확인";
  await expect(page.getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "댓글 작성" })).toHaveCount(0);
  await page
    .getByRole("link", { name: "내 글로 돌아가기", exact: true })
    .click();
  const statuses = page.getByRole("navigation", { name: "내 글 공개 상태" });
  await expect(
    statuses.getByRole("link", { name: `${label} 1`, exact: true }),
  ).toBeVisible();
  await statuses.getByRole("link", { name: `${label} 1`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/me\\?status=${result.status}$`));
  await expect(
    page.getByRole("link", {
      name: new RegExp(`비공개 검수 글 ${info.project.name}`),
    }),
  ).toBeVisible();
  await page.context().clearCookies();
  await page.goto("/?purpose=question&tag=Ghidra");
  await expect(page.locator("#feed-results")).toContainText("공개 글 0개");
  await expect(
    page.getByRole("navigation", { name: "주제", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "내 글 공개 상태" }),
  ).toHaveCount(0);
  await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  await expect(
    page.getByText(`비공개 검수 글 ${info.project.name}`, { exact: true }),
  ).toHaveCount(0);

  const guest = await playwright.request.newContext({ baseURL: origin });
  expect((await guest.get(`/api/posts/${result.id}`)).status()).toBe(404);
  expect(await (await guest.get("/api/posts")).text()).not.toContain(result.id);
  expect(await (await guest.get("/sitemap.xml")).text()).not.toContain(
    result.id,
  );
  await page.goto(`/posts/${result.id}`);
  await expect(
    page.getByRole("heading", {
      name: "페이지를 찾을 수 없습니다.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(`비공개 검수 글 ${info.project.name}`, { exact: true }),
  ).toHaveCount(0);

  await register(guest, origin);
  expect((await guest.get(`/api/posts/${result.id}`)).status()).toBe(404);
  await guest.dispose();
});
