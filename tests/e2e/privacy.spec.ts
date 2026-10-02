import { test, expect } from "@playwright/test";
import { register, post } from "./helpers";

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
  await expect(
    page.getByText("현재는 작성자만 이 글을 볼 수 있습니다.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "댓글 작성" })).toHaveCount(0);
  await page.context().clearCookies();

  const guest = await playwright.request.newContext({ baseURL: origin });
  expect((await guest.get(`/api/posts/${result.id}`)).status()).toBe(404);
  expect(await (await guest.get("/api/posts")).text()).not.toContain(result.id);
  expect(await (await guest.get("/sitemap.xml")).text()).not.toContain(
    result.id,
  );
  await page.goto(`/posts/${result.id}`);
  await expect(
    page.getByRole("heading", { name: "글을 찾을 수 없습니다." }),
  ).toBeVisible();
  await expect(
    page.getByText(`비공개 검수 글 ${info.project.name}`, { exact: true }),
  ).toHaveCount(0);

  await register(guest, origin);
  expect((await guest.get(`/api/posts/${result.id}`)).status()).toBe(404);
  await guest.dispose();
});
