import { test, expect } from "@playwright/test";
import { register, post } from "./helpers";
import Database from "better-sqlite3";
import { basename, dirname, resolve } from "node:path";

const createdPostIds: string[] = [];
test("수정본도 Jev 보류나 오류가 나면 작성자만 볼 수 있다", async ({
  page,
  playwright,
  baseURL,
}, info) => {
  const origin = baseURL!;
  await register(page.request, origin);
  const { result } = await post(
    page.request,
    origin,
    `격리 수정본 비공개 검수 ${info.project.name}`,
  );
  createdPostIds.push(result.id);
  const title = `새 조건을 반영한 비공개 수정본 ${info.project.name}`;
  const body =
    "격리 검수에서 수정본의 새로운 재현 조건과 오류 여부를 확인합니다.";
  await page.goto(`/posts/${result.id}?from=%2Fme`);
  await page.getByRole("link", { name: "수정", exact: true }).click();
  await page.getByLabel("제목", { exact: true }).fill(title);
  await page.getByLabel("본문", { exact: true }).fill(body);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(`/api/posts/${result.id}`),
  );
  await page
    .getByRole("button", { name: "수정 저장하기", exact: true })
    .click();
  expect((await saved).status()).toBe(202);
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "답변 작성" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "댓글 작성" })).toHaveCount(0);
  expect((await page.request.get(`/api/posts/${result.id}`)).status()).toBe(
    200,
  );
  const guest = await playwright.request.newContext({ baseURL: origin });
  try {
    expect((await guest.get(`/api/posts/${result.id}`)).status()).toBe(404);
    expect(await (await guest.get("/api/posts")).text()).not.toContain(
      result.id,
    );
    expect(await (await guest.get("/sitemap.xml")).text()).not.toContain(
      result.id,
    );
    await register(guest, origin);
    expect((await guest.get(`/api/posts/${result.id}`)).status()).toBe(404);
  } finally {
    await guest.dispose();
  }
});
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
  const filterLabel = result.status === "held" ? "공개 보류" : "확인 중";
  await expect(page.getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "답변 작성" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "댓글 작성" })).toHaveCount(0);
  await page
    .getByRole("link", { name: "내 글로 돌아가기", exact: true })
    .click();
  const statuses = page.getByRole("navigation", { name: "내 글 공개 상태" });
  await expect(
    statuses.getByRole("link", { name: `${filterLabel} 1`, exact: true }),
  ).toBeVisible();
  await statuses
    .getByRole("link", { name: `${filterLabel} 1`, exact: true })
    .click();
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
    page
      .getByRole("navigation", { name: "주제", exact: true })
      .getByRole("link"),
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
