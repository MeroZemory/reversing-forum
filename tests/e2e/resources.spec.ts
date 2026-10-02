import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { register } from "./helpers";

test("자료 길잡이의 공개 범위·검색·주제·페이지·복귀·참여 문맥", async ({
  page,
  baseURL,
}, info) => {
  const databasePath = String(info.project.metadata.databasePath);
  expect(dirname(databasePath)).toBe(resolve("data"));
  expect(basename(databasePath)).toMatch(/^e2e-[a-f0-9]+-pass\.sqlite$/);
  const db = new Database(databasePath);
  const ids: string[] = [];
  const prefix = `자료검수-${randomUUID().slice(0, 8)}`;
  const insert = db.prepare(
    "INSERT INTO posts (id,author_id,author_name,title,body,kind,tags,status,created_at) VALUES (?, 'resource-fixture', '검수 회원', ?, ?, 'question', ?, ?, ?)",
  );
  try {
    db.transaction(() => {
      for (let index = 0; index < 65; index++) {
        const id =
          index === 0 ? "2ce239d2-fb37-457c-a9ed-08bbf37fb67e" : randomUUID();
        ids.push(id);
        insert.run(
          id,
          `${prefix} Ghidra 함수 분석 ${index}`,
          "재현 조건과 일부 결과, 분석의 한계를 남긴 공개 검수 글입니다.",
          '["Ghidra"]',
          "published",
          new Date(Date.now() - index * 1000).toISOString(),
        );
      }
      for (const status of ["pending", "held"]) {
        const id = randomUUID();
        ids.push(id);
        insert.run(
          id,
          `${prefix} 비공개 ${status}`,
          "Ghidra 비공개 내용",
          '["Ghidra"]',
          status,
          new Date().toISOString(),
        );
      }
    })();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto("/resources");
      await expect(
        page.getByRole("heading", { name: "자료 길잡이", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "실행 파일 분석", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "글 쓰기", exact: true }),
      ).toHaveCount(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`resources-${width}.png`),
        fullPage: true,
      });
      await expect(
        page.getByText(`${prefix} 비공개`, { exact: false }),
      ).toHaveCount(0);
    }
    await page.setViewportSize({ width: 1440, height: 700 });
    await page
      .getByRole("heading", { name: "실행 파일 분석", exact: true })
      .getByRole("link")
      .click();
    await expect(page).toHaveURL(/\/resources\/executables$/);
    await expect(page.locator(".resource-posts > li")).toHaveCount(1);
    await page.locator(".resource-posts .post-title-line a").click();
    await expect(
      page.getByRole("link", { name: "목록으로 돌아가기" }),
    ).toHaveAttribute("href", "/resources/executables");
    await page.goto("/resources");
    await page.getByRole("textbox", { name: "글 검색" }).fill(prefix);
    await page.getByRole("button", { name: "검색", exact: true }).click();
    await expect(page).toHaveURL(/\/resources\?q=/);
    await expect(page.locator(".resource-posts > li")).toHaveCount(30);
    await page.getByRole("link", { name: "다음", exact: true }).click();
    await expect(page).toHaveURL(/page=2/);
    await page.locator(".resource-posts .topic-inline").first().click();
    await expect(page).toHaveURL(/\/resources\?tag=Ghidra$/);
    await page.getByRole("textbox", { name: "글 검색" }).fill(prefix);
    await page.getByRole("button", { name: "검색", exact: true }).click();
    await expect(page).toHaveURL(/tag=Ghidra&q=/);
    await page.getByRole("link", { name: "다음", exact: true }).click();
    await expect(page).toHaveURL(/page=2/);
    const from = new URL(page.url()).pathname + new URL(page.url()).search;
    const target = page.locator(".resource-posts .post-title-line a").nth(10);
    await target.scrollIntoViewIfNeeded();
    const y = await page.evaluate(() => window.scrollY);
    await target.click();
    await expect(
      page.getByRole("link", { name: "목록으로 돌아가기" }),
    ).toHaveAttribute("href", from);
    const postPath = new URL(page.url()).pathname + new URL(page.url()).search;
    const loginHref = await page
      .locator('#comments a[href^="/login"]')
      .getAttribute("href");
    expect(new URL(loginHref!, baseURL).searchParams.get("returnTo")).toBe(
      postPath + "#comments",
    );
    await page.getByRole("link", { name: "목록으로 돌아가기" }).click();
    await expect(page).toHaveURL(new RegExp("page=2"));
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(y - 100);
    await page.getByRole("link", { name: "글 쓰기", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?returnTo=/);
    const write = new URL(page.url()).searchParams.get("returnTo")!;
    expect(new URL(write, baseURL).searchParams.get("from")).toBe(from);
    await register(page.request, baseURL!);
    await page.goto(postPath);
    await page.locator("#comment-new").fill("자료의 재현 조건을 확인했습니다.");
    await page.getByRole("button", { name: "댓글 등록", exact: true }).click();
    await expect(
      page.getByText("자료의 재현 조건을 확인했습니다.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "목록으로 돌아가기" }),
    ).toHaveAttribute("href", from);
    expect(errors).toEqual([]);
  } finally {
    db.transaction(() => {
      for (const id of ids) {
        db.prepare("DELETE FROM comments WHERE post_id=?").run(id);
        db.prepare("DELETE FROM posts WHERE id=?").run(id);
      }
    })();
    db.close();
  }
});
