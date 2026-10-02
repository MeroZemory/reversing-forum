import { test, expect, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { basename, dirname, resolve } from "node:path";
import { register, post } from "./helpers";

function isolatedDatabase(info: TestInfo) {
  const databasePath = String(info.project.metadata.databasePath);
  expect(dirname(databasePath)).toBe(resolve("data"));
  expect(basename(databasePath)).toMatch(/^e2e-[a-f0-9]+-pass\.sqlite$/);
  return new Database(databasePath);
}

const createdPostIds: string[] = [];
test.afterEach(async ({}, info) => {
  if (!createdPostIds.length) return;
  const db = isolatedDatabase(info);
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

test("목록 탭·검색·뒤로가기의 상태와 스크롤을 유지한다", async ({
  page,
}, info) => {
  // Fixtures belong only to this run's isolated database, never the preview DB.
  const db = isolatedDatabase(info);
  const fixtureIds: string[] = [];
  const insert = db.prepare(`INSERT INTO posts
    (id, author_id, author_name, title, body, kind, tags, status, created_at)
    VALUES (?, 'navigation-fixture', '검수용 회원', ?, ?, ?, '[]', 'published', ?)`);
  const kinds = ["discussion", "question", "analysis", "workflow"];
  const sampleTitles = [
    "다들 분석 노트를 어떤 형식으로 남기시나요?",
    "x64dbg에서 TLS 콜백의 실행 순서를 확인하는 방법",
    "PE 임포트 테이블을 따라 함수 호출 관계 정리하기",
    "Ghidra MCP와 AI로 세운 가설을 검증한 과정",
    "정적 분석과 동적 분석을 오가며 놓쳤던 단서들",
    "최적화된 C++ 바이너리에서 vtable을 찾고 싶습니다",
    "ARM64 함수 프롤로그와 레지스터 사용 기록",
    "AI 디컴파일 결과를 원본 어셈블리와 비교해 보기",
  ];
  try {
    db.transaction(() => {
      for (let index = 0; index < 120; index++) {
        const id = randomUUID();
        fixtureIds.push(id);
        insert.run(
          id,
          `${sampleTitles[index % sampleTitles.length]} · 목록검수 ${index}`,
          "재현 환경과 관찰 결과를 확인하는 화면 검수용 글입니다.",
          kinds[index % kinds.length],
          new Date(Date.now() - index * 1000).toISOString(),
        );
      }
    })();
    const sitemap = await page.request.get("/sitemap.xml");
    expect(sitemap.status()).toBe(200);
    const sitemapXml = await sitemap.text();
    for (const id of fixtureIds) expect(sitemapXml).toContain(`/posts/${id}`);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto("/");
      await expect(
        page.getByRole("link", { name: "글 쓰기", exact: true }),
      ).toHaveCount(1);
      await expect(page.locator('a[href="/login"]')).toHaveCount(1);
      await expect(page.locator('a[href="/register"]')).toHaveCount(1);
      await expect(
        page.getByRole("navigation", { name: "글 목적", exact: true }),
      ).toHaveCount(1);
      await expect(
        page.getByRole("navigation", { name: "주요 메뉴", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "최신 글",
      );
      await page.screenshot({
        path: `test-results/design-home-${width}.png`,
        caret: "initial",
      });
      const skipLink = page.getByRole("link", { name: "본문으로 바로가기" });
      await page.keyboard.press("Tab");
      await expect(skipLink).toBeFocused();
      await expect(skipLink).toBeInViewport();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("main")).toBeFocused();
      await expect(skipLink).not.toBeInViewport();
      const tabs = page.getByRole("navigation", {
        name: "글 목적",
        exact: true,
      });
      await expect(tabs.getByRole("link")).toHaveText([
        "전체",
        "질문",
        "공유",
        "자유",
      ]);
      const analysis = tabs.getByRole("link", { name: "공유", exact: true });
      const box = await analysis.boundingBox();
      expect(box).not.toBeNull();
      const currentScroll = await page.evaluate(() => window.scrollY);
      const scrollPosition = Math.max(
        20,
        Math.floor(box!.y + currentScroll - 85),
      );
      await page.evaluate(
        (y) => window.scrollTo({ top: y, behavior: "instant" }),
        scrollPosition,
      );
      const before = await page.evaluate(() => window.scrollY);
      expect(before).toBeGreaterThan(0);
      await analysis.click();
      await expect(page).toHaveURL(/purpose=share/);
      await expect(analysis).toHaveAttribute("aria-current", "page");
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
      await page.getByRole("textbox", { name: "글 검색" }).fill("목록검수");
      await page.getByRole("button", { name: "검색", exact: true }).click();
      await expect(page).toHaveURL(/purpose=share&q=/);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
      await expect(
        page.getByRole("table", { name: "게시글 목록" }),
      ).toBeVisible();
      await tabs.getByRole("link", { name: "질문", exact: true }).click();
      await expect(page).toHaveURL(/purpose=question&q=/);
      await expect(page.getByRole("textbox", { name: "글 검색" })).toHaveValue(
        "목록검수",
      );
      await expect(skipLink).not.toBeInViewport();
      await expect(
        page.getByRole("heading", { name: "검색 결과", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "검색어 지우기", exact: true })
        .click();
      await expect(page).toHaveURL(/\?purpose=question$/);
      await expect(page.getByRole("textbox", { name: "글 검색" })).toHaveValue(
        "",
      );
      await page.goBack();
      await expect(page).toHaveURL(/purpose=question&q=/);
      await expect(page.getByRole("textbox", { name: "글 검색" })).toHaveValue(
        "목록검수",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBeTruthy();
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: "instant" }),
      );
      await page.screenshot({
        path: `test-results/forum-populated-${width}.png`,
        fullPage: true,
        caret: "initial",
      });
    }
    expect(errors).toEqual([]);
  } finally {
    const remove = db.prepare("DELETE FROM posts WHERE id = ?");
    db.transaction(() => fixtureIds.forEach((id) => remove.run(id)))();
    db.close();
  }
});

test("비회원 읽기와 모바일 화면, 회원 작성·댓글·로그아웃", async ({
  page,
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "최신 글", exact: true }),
  ).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(
      page.getByRole("link", { name: "글 쓰기", exact: true }),
    ).toHaveCount(1);
    const account = page.getByRole("navigation", { name: "계정", exact: true });
    await expect(
      account.getByRole("link", { name: "로그인", exact: true }),
    ).toBeVisible();
    await expect(
      account.getByRole("link", { name: "회원가입", exact: true }),
    ).toBeVisible();
    for (const control of [
      account.getByRole("link", { name: "로그인", exact: true }),
      account.getByRole("link", { name: "회원가입", exact: true }),
      page.getByRole("link", { name: "글 쓰기", exact: true }),
      page
        .getByRole("navigation", { name: "글 목적" })
        .getByRole("link", { name: "공유", exact: true }),
      page.getByRole("button", { name: "검색", exact: true }),
    ]) {
      const box = await control.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "test-results/home-desktop.png",
    fullPage: true,
    caret: "initial",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "최신 글", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/home-mobile.png",
    fullPage: true,
    caret: "initial",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto("/?purpose=share&q=missing-search-fixture");
  await expect(page.getByRole("status")).toContainText(
    "검색어에 맞는 글이 없습니다.",
  );
  await page.getByRole("link", { name: "검색어 지우기", exact: true }).click();
  await expect(page).toHaveURL(/\?purpose=share$/);
  await expect(page.getByRole("status")).toContainText(
    "아직 공개된 공유 글이 없습니다.",
  );
  await page.getByRole("link", { name: "전체 글 보기", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/`);
  await page.goto("/?purpose=share&q=missing-search-fixture");
  await page
    .getByRole("link", { name: "모든 조건 지우기", exact: true })
    .click();
  await expect(page).toHaveURL(`${origin}/`);

  await page.goto("/new");
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await page.goto("/register?returnTo=%2Fnew");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(
      page.getByRole("heading", { name: "회원가입", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: `test-results/design-auth-${width}.png`,
      caret: "initial",
    });
  }
  await page.getByLabel("닉네임").fill("첫번째회원");
  await page.getByLabel("이메일").fill(`ui-${randomUUID()}@example.com`);
  const password = page.getByLabel("비밀번호", { exact: true });
  const passwordHint = page.getByText("비밀번호는 10~128자로 입력해 주세요.", {
    exact: true,
  });
  await expect(passwordHint).toBeVisible();
  await password.fill("Test-only-passphrase-42!");
  await expect(passwordHint).toBeVisible();
  await page
    .getByRole("button", { name: "비밀번호 표시하기", exact: true })
    .click();
  await expect(password).toHaveAttribute("type", "text");
  await page
    .getByRole("button", { name: "비밀번호 숨기기", exact: true })
    .click();
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "회원가입", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/new`);
  await page
    .getByRole("navigation", { name: "계정" })
    .getByRole("link", { name: "내 글", exact: true })
    .click();
  await expect(
    page.getByText("아직 남긴 글이 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "글 쓰기", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("link", { name: "글 쓰기", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/new?from=%2Fme`);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByLabel("제목", { exact: true })).toBeVisible();
    const tags = page.getByLabel("태그", { exact: false });
    await tags.scrollIntoViewIfNeeded();
    await expect(tags).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: `test-results/design-editor-${width}.png`,
      caret: "initial",
    });
  }

  const title = `함수 호출 분석 ${randomUUID().slice(0, 8)}`;
  await expect(page.getByRole("combobox")).toHaveCount(0);
  const purposes = page.getByRole("group", { name: "작성 목적" });
  await purposes.getByRole("radio", { name: "공유", exact: true }).check();
  await expect(
    purposes.getByRole("radio", { name: "공유", exact: true }),
  ).toHaveValue("analysis");
  await page.getByLabel("제목", { exact: true }).fill(title);
  await page
    .getByLabel("본문", { exact: true })
    .fill(
      "Ghidra로 PE 파일의 함수 호출 관계를 확인한 과정을 공유합니다. 재현 환경과 관찰한 결과를 함께 남깁니다.",
    );
  await page.getByLabel("태그", { exact: false }).fill("Windows, Ghidra");
  await page.getByRole("button", { name: "글 등록하기" }).click();
  await expect(page).toHaveURL(/\/posts\/[a-f0-9-]+(?:\?.*)?$/);
  const postUrl = page.url();
  const id = new URL(postUrl).pathname.split("/").pop()!;
  createdPostIds.push(id);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  const anonymous = await browser.newContext();
  const publicResponse = await anonymous.request.get(
    `${origin}/api/posts/${id}`,
  );
  expect(publicResponse.status()).toBe(200);
  expect(await publicResponse.text()).not.toContain("screening_evidence");
  const guest = await anonymous.newPage();
  await guest.goto(postUrl);
  await expect(guest.getByRole("heading", { name: title })).toBeVisible();
  await expect(
    guest.getByRole("link", { name: "로그인", exact: true }).first(),
  ).toBeVisible();
  await anonymous.close();

  await page
    .getByLabel("댓글 작성", { exact: true })
    .fill("확인한 근거를 조금 더 나누고 싶습니다.");
  await page.getByRole("button", { name: "댓글 등록", exact: true }).click();
  await expect(
    page.getByText("확인한 근거를 조금 더 나누고 싶습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "답글", exact: true }).click();
  const closeReply = page.getByRole("button", {
    name: "답글 닫기",
    exact: true,
  });
  await expect(closeReply).toBeVisible();
  await closeReply.click();
  await expect(page.getByLabel("첫번째회원님에게 답글")).toHaveCount(0);
  await page.getByRole("button", { name: "답글", exact: true }).click();
  await expect(closeReply).toBeVisible();
  await page
    .getByLabel("첫번째회원님에게 답글")
    .fill("추가로 확인한 내용은 답글로 이어갑니다.");
  // The real comment flood limit requires five seconds between writes.
  await page.waitForTimeout(5100);
  await page.getByRole("button", { name: "답글 등록", exact: true }).click();
  await expect(
    page.getByText("추가로 확인한 내용은 답글로 이어갑니다.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "답글", exact: true }),
  ).toBeFocused();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: "test-results/post-desktop.png",
    fullPage: true,
    caret: "initial",
  });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const account = page.getByRole("navigation", { name: "계정" });
    await expect(
      account.getByRole("link", { name: "내 글", exact: true }),
    ).toBeVisible();
    await expect(
      account.getByRole("button", { name: "로그아웃", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    const commentsHeading = page.getByRole("heading", {
      name: "댓글 2",
      exact: true,
    });
    await commentsHeading.scrollIntoViewIfNeeded();
    await expect(commentsHeading).toBeInViewport();
    await page.screenshot({
      path: `test-results/post-viewport-${width}.png`,
      caret: "initial",
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page
      .getByRole("navigation", { name: "계정" })
      .getByRole("link", { name: "내 글", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "로그아웃", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: "test-results/post-mobile.png",
    fullPage: true,
    caret: "initial",
  });
  await page
    .getByRole("navigation", { name: "계정" })
    .getByRole("link", { name: "내 글", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "내가 쓴 글", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "글 쓰기", exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  const statusTabs = page.getByRole("navigation", { name: "내 글 공개 상태" });
  await expect(statusTabs.getByRole("link")).toHaveText([
    "전체 1",
    "공개 1",
    "공개 전 확인 0",
    "공개 보류 0",
  ]);
  await statusTabs.getByRole("link", { name: "공개 1", exact: true }).click();
  await expect(page).toHaveURL(/\/me\?status=published$/);
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto(`/?q=${encodeURIComponent(title)}`);
  await expect(
    page.getByRole("link", { name: title, exact: true }),
  ).toBeVisible();
  const structured = await page.request.get(postUrl);
  expect(await structured.text()).toContain("DiscussionForumPosting");
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(
    page.getByRole("banner").getByRole("link", { name: "로그인", exact: true }),
  ).toBeVisible();
  const denied = await page.request.post("/api/posts", {
    headers: { Origin: origin },
    data: {
      title: "비회원 글",
      body: "비회원은 게시물을 등록할 수 없습니다.",
      kind: "discussion",
      tags: [],
    },
  });
  expect(denied.status()).toBe(401);
  expect(errors).toEqual([]);
});

test("내 보류 글에서 작성·취소하거나 공개 상태가 바뀐 글을 읽어도 원래 보류 목록으로 돌아온다", async ({
  page,
  browser,
  baseURL,
}, info) => {
  await register(page.request, baseURL!);
  const title = `보류 목록 복귀 ${randomUUID().slice(0, 8)}`;
  const created = await post(page.request, baseURL!, title);
  const id = created.result.id;
  createdPostIds.push(id);
  const db = isolatedDatabase(info);
  const anonymous = await browser.newContext();
  try {
    db.prepare("UPDATE posts SET status='held' WHERE id=?").run(id);
    expect(
      (await anonymous.request.get(`${baseURL}/api/posts/${id}`)).status(),
    ).toBe(404);
    const guest = await anonymous.newPage();
    await guest.goto(`${baseURL}/?q=${encodeURIComponent(title)}`);
    await expect(
      guest.getByRole("link", { name: title, exact: true }),
    ).toHaveCount(0);
    await expect(
      guest.getByRole("navigation", { name: "내 글 공개 상태" }),
    ).toHaveCount(0);
    await page.goto("/me?status=held");
    const statuses = page.getByRole("navigation", { name: "내 글 공개 상태" });
    await expect(
      statuses.getByRole("link", { name: "공개 보류 1", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "글 쓰기", exact: true }).click();
    await expect(page).toHaveURL(
      `${baseURL}/new?from=${encodeURIComponent("/me?status=held")}`,
    );
    const cancel = page.getByRole("link", { name: "목록으로", exact: true });
    await expect(cancel).toHaveAttribute("href", "/me?status=held");
    await cancel.click();
    await expect(page).toHaveURL(`${baseURL}/me?status=held`);
    const ownPost = page.getByRole("link", { name: new RegExp(title) });
    await expect(ownPost).toBeVisible();
    // The list was opened while held; screening finishes before the article is read.
    db.prepare("UPDATE posts SET status='published' WHERE id=?").run(id);
    await ownPost.click();
    await expect(page).toHaveURL(
      `${baseURL}/posts/${id}?from=${encodeURIComponent("/me?status=held")}`,
    );
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("공개 보류", { exact: true })).toHaveCount(0);
    const back = page.getByRole("link", {
      name: "내 글로 돌아가기",
      exact: true,
    });
    await expect(back).toHaveAttribute("href", "/me?status=held");
    await back.click();
    await expect(page).toHaveURL(`${baseURL}/me?status=held`);
    await expect(
      statuses.getByRole("link", { name: "공개 보류 0", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", {
        name: "공개 보류 글이 없습니다.",
        exact: true,
      }),
    ).toBeVisible();
    await statuses.getByRole("link", { name: "공개 1", exact: true }).click();
    await expect(
      page.getByRole("link", { name: new RegExp(title) }),
    ).toBeVisible();
    await guest.goto(`${baseURL}/posts/${id}`);
    await expect(
      guest.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(guest.getByText("공개 보류", { exact: true })).toHaveCount(0);
    await expect(
      guest.getByRole("navigation", { name: "내 글 공개 상태" }),
    ).toHaveCount(0);
  } finally {
    db.close();
    await anonymous.close();
  }
});

test("글 등록 대기 중 입력과 목적·미리보기 변경을 막는다", async ({
  page,
  baseURL,
}) => {
  await register(page.request, baseURL!);
  await page.goto("/new");
  const title = page.getByLabel("제목", { exact: true });
  const body = page.getByLabel("본문", { exact: true });
  const tags = page.getByLabel("태그", { exact: false });
  const values = {
    title: "대기 중인 분석 글",
    body: "등록 응답을 기다리는 동안 보존해야 하는 분석 내용입니다.",
    tags: "Ghidra",
  };
  await title.fill(values.title);
  await body.fill(values.body);
  await tags.fill(values.tags);
  let submitted: Record<string, unknown> | undefined;
  let release!: () => void;
  const heldResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/posts",
    async (route) => {
      submitted = route.request().postDataJSON();
      await heldResponse;
      await route.fulfill({
        status: 400,
        json: { error: "테스트 응답: 입력한 내용을 다시 확인해 주세요." },
      });
    },
    { times: 1 },
  );
  try {
    await page
      .getByRole("button", { name: "글 등록하기", exact: true })
      .click();
    await expect.poll(() => submitted).toBeDefined();
    for (const field of [title, body, tags]) {
      await expect(field).toHaveJSProperty("readOnly", true);
      await expect(field).not.toBeEditable();
      await field.focus();
      await page.keyboard.type("변경 시도");
    }
    await expect(title).toHaveValue(values.title);
    await expect(body).toHaveValue(values.body);
    await expect(tags).toHaveValue(values.tags);
    for (const radio of await page
      .getByRole("group", { name: "작성 목적" })
      .getByRole("radio")
      .all()) {
      await expect(radio).toBeDisabled();
    }
    for (const name of ["작성", "미리보기"]) {
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeDisabled();
    }
    await expect(page.locator("form.editor-form")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(submitted).toEqual({
      title: values.title,
      body: values.body,
      kind: "discussion",
      tags: ["Ghidra"],
    });
    release();
    await expect(page.locator("form.editor-form .form-error")).toHaveText(
      "테스트 응답: 입력한 내용을 다시 확인해 주세요.",
    );
    for (const field of [title, body, tags]) await expect(field).toBeEditable();
    await expect(title).toHaveValue(values.title);
    await expect(body).toHaveValue(values.body);
    await expect(tags).toHaveValue(values.tags);
    await expect(
      page.getByRole("button", { name: "미리보기", exact: true }),
    ).toBeEnabled();
  } finally {
    release();
    await page.unroute("**/api/posts");
  }
});

for (const reply of [false, true]) {
  test(`${reply ? "답글" : "댓글"} 등록 대기 중 수정을 막고 401 재로그인 후 같은 초안을 복원한다`, async ({
    page,
    baseURL,
  }, info) => {
    await register(page.request, baseURL!);
    const created = await post(
      page.request,
      baseURL!,
      `댓글 복구 검수 ${randomUUID().slice(0, 8)}`,
    );
    const id = created.result.id;
    createdPostIds.push(id);
    const parentId = randomUUID();
    if (reply) {
      const db = isolatedDatabase(info);
      try {
        db.prepare(
          "INSERT INTO comments(id,post_id,parent_id,author_id,author_name,body,created_at) VALUES(?,?,NULL,?,?,?,?)",
        ).run(
          parentId,
          id,
          "reply-fixture",
          "원댓글회원",
          "답글을 받는 원댓글입니다.",
          "2026-10-01T00:00:00.000Z",
        );
      } finally {
        db.close();
      }
    }
    const from = "/?purpose=question&tag=Ghidra&q=recovery&page=2";
    const postPath = `/posts/${id}?from=${encodeURIComponent(from)}`;
    await page.goto(postPath);
    const rootInput = page.getByLabel("댓글 작성", { exact: true });
    const rootDraft = "답글 초안과 구분하여 남겨 둔 원댓글 초안입니다.";
    if (reply) {
      await rootInput.fill(rootDraft);
      await page.getByRole("button", { name: "답글", exact: true }).click();
    }
    const input = reply
      ? page.getByLabel("원댓글회원님에게 답글", { exact: true })
      : rootInput;
    const draft = `${reply ? "답글" : "댓글"} 세션 만료 후에도 그대로 복원해야 하는 내용입니다.`;
    await input.fill(draft);
    let submitted: Record<string, unknown> | undefined;
    let release!: () => void;
    const heldResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    let intercepted = 0;
    const endpoint = `**/api/posts/${id}/comments`;
    await page.route(
      endpoint,
      async (route) => {
        intercepted++;
        submitted = route.request().postDataJSON();
        await heldResponse;
        await route.fulfill({
          status: 401,
          json: { error: "로그인이 필요합니다." },
        });
      },
      { times: 1 },
    );
    try {
      await page
        .getByRole("button", {
          name: reply ? "답글 등록" : "댓글 등록",
          exact: true,
        })
        .click();
      await expect.poll(() => submitted).toBeDefined();
      await expect(input).toHaveJSProperty("readOnly", true);
      await expect(input).not.toBeEditable();
      await input.focus();
      await page.keyboard.type("변경 시도");
      await expect(input).toHaveValue(draft);
      const form = page.locator("form.comment-form").filter({ has: input });
      await expect(form).toHaveAttribute("aria-busy", "true");
      await expect(
        form.getByRole("button", { name: "등록 중…", exact: true }),
      ).toBeDisabled();
      expect(submitted).toEqual({
        body: draft,
        parentId: reply ? parentId : null,
      });
      release();
      await expect(form.locator(".form-error")).toHaveText(
        "댓글을 남기려면 다시 로그인해 주세요.",
      );
      await expect(input).toBeEditable();
      await expect(input).toHaveValue(draft);
      const login = form.getByRole("link", {
        name: "다시 로그인",
        exact: true,
      });
      await expect(login).toHaveAttribute(
        "href",
        `/login?returnTo=${encodeURIComponent(`${postPath}#comments`)}`,
      );
      await login.click(); // The valid cookie is retained; SSR returns the same member to this article.
      await expect(page).toHaveURL(`${baseURL}${postPath}#comments`);
      await expect(input).toHaveValue(draft);
      if (reply) {
        await expect(
          page.getByRole("button", { name: "답글 닫기", exact: true }),
        ).toBeVisible();
        await expect(rootInput).toHaveValue(rootDraft);
      }
      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/posts/${id}/comments`) &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("button", {
          name: reply ? "답글 등록" : "댓글 등록",
          exact: true,
        })
        .click();
      expect((await saved).status()).toBe(201);
      await expect(page.getByText(draft, { exact: true })).toBeVisible();
      expect(intercepted).toBe(1);
      if (reply) {
        await expect(
          page.getByRole("button", { name: "답글", exact: true }),
        ).toBeFocused();
        await expect(rootInput).toHaveValue(rootDraft);
      } else {
        await expect(rootInput).toHaveValue("");
      }
    } finally {
      release();
      await page.unroute(endpoint);
    }
  });
}

test("실패한 글의 데이터를 고친 뒤 다시 시도하면 같은 글을 불러온다", async ({
  page,
}, info) => {
  const db = isolatedDatabase(info);
  const id = randomUUID();
  const title = `다시 불러올 분석 ${randomUUID().slice(0, 8)}`;
  const body =
    "손상된 태그만 복구하면 같은 글의 실제 분석 내용을 다시 읽을 수 있습니다.";
  const malformedTags = `malformed-${id.slice(0, 8)}`;
  createdPostIds.push(id);
  const unexpected: string[] = [];
  const expectedErrors: string[] = [];
  let causingMalformedTags = true;
  function record(message: string) {
    // The only intentional exception is JSON.parse on this fixture's malformed tags.
    if (
      causingMalformedTags &&
      message.includes("Unexpected token") &&
      message.includes(malformedTags)
    ) {
      expectedErrors.push(message);
    } else {
      unexpected.push(message);
    }
  }
  page.on("pageerror", (error) => record(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location().url;
    // Chromium also reports the deliberately failed document request as a resource error.
    // Scope this exception to the malformed fixture's exact URL while it is broken.
    if (
      causingMalformedTags &&
      message.text() ===
        "Failed to load resource: the server responded with a status of 500 (Internal Server Error)" &&
      location &&
      new URL(location).pathname === `/posts/${id}`
    )
      return;
    record(message.text());
  });
  try {
    db.prepare(
      "INSERT INTO posts(id,author_id,author_name,title,body,kind,tags,status,created_at) VALUES(?,?,?,?,?,?,?,'published',?)",
    ).run(
      id,
      "retry-fixture",
      "복구검수회원",
      title,
      body,
      "analysis",
      malformedTags,
      "2026-10-01T00:00:00.000Z",
    );
    const failed = await page.goto(`/posts/${id}`);
    expect(failed?.status()).toBe(500);
    await expect(
      page.getByRole("heading", {
        name: "페이지를 불러오지 못했습니다.",
        exact: true,
      }),
    ).toBeVisible();
    await expect.poll(() => expectedErrors.length).toBeGreaterThan(0);
    expect(unexpected).toEqual([]);
    db.prepare("UPDATE posts SET tags=? WHERE id=?").run(
      JSON.stringify(["Ghidra"]),
      id,
    );
    causingMalformedTags = false;
    await page
      .getByRole("button", { name: "다시 시도하기", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(body, { exact: true })).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === `/posts/${id}`);
    await expect(
      page.getByRole("link", { name: "Ghidra 주제 글 보기", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "다시 시도하기", exact: true }),
    ).toHaveCount(0);
    expect(unexpected).toEqual([]);
  } finally {
    db.close();
  }
});

test("인증 복귀 주소를 안전하게 처리하고 로그인 오류에서 회복한다", async ({
  page,
  request,
  baseURL,
}) => {
  const unsafeQueries = [
    "returnTo=%2Fnew&returnTo=%2Fme",
    "returnTo=%2F%2Fattacker.example",
    "returnTo=%2F%09%2Fattacker.example",
    "returnTo=%2Flogin",
  ];
  for (const route of ["login", "register"]) {
    for (const query of unsafeQueries) {
      await page.goto(`/${route}?${query}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        route === "login" ? "로그인" : "회원가입",
      );
      const switchLink = page.getByRole("main").getByRole("link", {
        name: route === "login" ? "회원가입" : "로그인",
        exact: true,
      });
      const href = new URL((await switchLink.getAttribute("href"))!, baseURL);
      expect(href.origin).toBe(new URL(baseURL!).origin);
      expect(href.searchParams.get("returnTo")).toBe("/");
    }
  }
  const signup = await register(request, baseURL!);
  const { user } = await signup.json();
  const destination = "/?purpose=share&tag=Ghidra&q=assembly&page=2";
  await page.goto(`/login?returnTo=${encodeURIComponent(destination)}`);
  await page.getByLabel("이메일", { exact: true }).fill(user.email);
  const password = page.getByLabel("비밀번호", { exact: true });
  await password.fill("wrong-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  const error = page.locator("#auth-error");
  await expect(error).toHaveAttribute("role", "alert");
  await expect(error).toHaveText(
    "로그인하지 못했습니다. 이메일과 비밀번호를 확인해 주세요.",
  );
  await expect(error).toBeFocused();
  await expect(page.getByLabel("이메일", { exact: true })).toHaveValue(
    user.email,
  );
  await password.fill("Test-only-passphrase-42!");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}${destination}`);
  await expect(
    page
      .getByRole("navigation", { name: "계정" })
      .getByRole("link", { name: "내 글", exact: true }),
  ).toBeVisible();
});

test("작성 목적·Markdown 미리보기와 회원·탭별 임시저장을 제공한다", async ({
  page,
  browser,
  baseURL,
}) => {
  await register(page.request, baseURL!);
  const ownerSession = await page.context().storageState();
  await page.goto("/new?purpose=question&tag=Ghidra");
  const purposes = page.getByRole("group", { name: "작성 목적" });
  await expect(page.getByRole("combobox")).toHaveCount(0);
  for (const [name, value] of [
    ["질문", "question"],
    ["공유", "analysis"],
    ["자유", "discussion"],
  ]) {
    await expect(
      purposes.getByRole("radio", { name, exact: true }),
    ).toHaveValue(value);
  }
  await expect(
    purposes.getByRole("radio", { name: "질문", exact: true }),
  ).toBeChecked();
  await expect(page.getByLabel("태그", { exact: false })).toHaveValue("Ghidra");
  const title = `임시 분석 ${randomUUID().slice(0, 8)}`;
  const body =
    "## 관찰한 함수\n\n**확인한 근거**를 함께 기록합니다.\n\n```asm\nmov eax, 42\nret\n```";
  await purposes.getByRole("radio", { name: "공유", exact: true }).check();
  await page.getByLabel("제목", { exact: true }).fill(title);
  const bodyInput = page.getByLabel("본문", { exact: true });
  await bodyInput.fill(body);
  await page.getByLabel("태그", { exact: false }).fill("Ghidra, assembly");
  await page.getByRole("button", { name: "미리보기", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "관찰한 함수", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("main").locator("pre code")).toHaveText(
    "mov eax, 42\nret",
  );
  await page.getByRole("button", { name: "작성", exact: true }).click();
  await expect(bodyInput).toHaveValue(body);
  await page.reload();
  await expect(page.getByLabel("제목", { exact: true })).toHaveValue(title);
  await expect(bodyInput).toHaveValue(body);
  await expect(bodyInput).toHaveAccessibleName("본문");
  await expect(bodyInput).toHaveAccessibleDescription(
    "코드는 ```asm 또는 ```cpp로 시작하고 ```로 닫아 주세요. HTML과 외부 이미지는 표시하지 않습니다.",
  );
  await expect(page.getByLabel("태그", { exact: false })).toHaveValue(
    "Ghidra, assembly",
  );
  await expect(
    purposes.getByRole("radio", { name: "공유", exact: true }),
  ).toBeChecked();

  const otherTab = await browser.newContext({ storageState: ownerSession });
  try {
    const blank = await otherTab.newPage();
    await blank.goto(`${baseURL}/new`);
    await expect(blank.getByLabel("제목", { exact: true })).toHaveValue("");
    await expect(blank.getByLabel("본문", { exact: true })).toHaveValue("");
    await register(otherTab.request, baseURL!);
    const otherSession = await otherTab.storageState();
    await page.context().clearCookies();
    await page.context().addCookies(otherSession.cookies);
    await page.goto("/new");
    await expect(page.getByLabel("제목", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("본문", { exact: true })).toHaveValue("");
    await page.context().clearCookies();
    await page.context().addCookies(ownerSession.cookies);
    await page.goto("/new");
    await expect(page.getByLabel("제목", { exact: true })).toHaveValue(title);
    await expect(bodyInput).toHaveValue(body);
  } finally {
    await otherTab.close();
  }
});

test("정확한 주제·목적·검색과 페이지를 유지하며 글에서 목록 위치로 돌아온다", async ({
  page,
}, info) => {
  const db = isolatedDatabase(info);
  const token = randomUUID().slice(0, 8);
  const tag = `topic-${token}`;
  const query = `discovery-${token}`;
  const privateTag = `private-${token}`;
  const insert = db.prepare(`INSERT INTO posts
    (id, author_id, author_name, title, body, kind, tags, status, created_at)
    VALUES (?, 'discovery-fixture', '주제 검수 회원', ?, ?, ?, ?, ?, ?)`);
  function seed(
    index: number,
    kind: string,
    tags: string[],
    status = "published",
    matchesQuery = true,
  ) {
    const id = randomUUID();
    createdPostIds.push(id);
    insert.run(
      id,
      `${matchesQuery ? query : "다른 검색어"} ${index}`,
      `관찰 결과를 공유합니다. ${tag}`,
      kind,
      JSON.stringify(tags),
      status,
      new Date(Date.now() - index * 1000).toISOString(),
    );
    return id;
  }
  const shareIds: string[] = [];
  const privateIds: string[] = [];
  try {
    db.transaction(() => {
      for (let index = 0; index < 36; index++) {
        shareIds.push(
          seed(index, index % 2 ? "workflow" : "analysis", [
            index % 2 ? tag.toUpperCase() : tag,
          ]),
        );
      }
      seed(36, "question", [tag]);
      seed(37, "analysis", [tag], "published", false);
      seed(38, "analysis", []); // Body mentions the exact topic, but it is not tagged.
      seed(39, "workflow", [`${tag}-extra`]);
      privateIds.push(seed(40, "analysis", [tag, privateTag], "pending"));
      privateIds.push(seed(41, "workflow", [tag, privateTag], "held"));
    })();
  } finally {
    db.close();
  }
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto("/");
  await page.locator("summary").filter({ hasText: "주제별로 찾기" }).click();
  // The displayed representative casing is chosen by SQLite, so inspect its URL.
  const topicLink = page
    .getByRole("navigation", { name: "주제", exact: true })
    .getByRole("link")
    .filter({ hasText: new RegExp(`#${tag}`, "i") })
    .first();
  await expect(topicLink).toBeVisible();
  await expect(topicLink.locator('[aria-label="공개 글 38개"]')).toHaveText(
    "38",
  );
  const topicHref = await topicLink.getAttribute("href");
  const topicParams = new URL(topicHref!, "http://fixture.test").searchParams;
  expect([...topicParams.keys()]).toEqual(["tag"]);
  expect(topicParams.get("tag")?.toLowerCase()).toBe(tag);
  await expect(
    page
      .getByRole("navigation", { name: "주제", exact: true })
      .getByText(privateTag, { exact: false }),
  ).toHaveCount(0);
  await topicLink.click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("tag")?.toLowerCase() === tag,
  );
  const selectedTag = new URL(page.url()).searchParams.get("tag")!;
  await expect(page.locator("#feed-results")).toContainText("공개 글 38개");
  const tabs = page.getByRole("navigation", { name: "글 목적", exact: true });
  await tabs.getByRole("link", { name: "공유", exact: true }).click();
  await expect(page.locator("#feed-results")).toContainText("공개 글 37개");
  await page.getByRole("textbox", { name: "글 검색" }).fill(query);
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("검색 결과");
  await expect(page.locator("#feed-results")).toContainText("공개 글 36개");
  const table = page.getByRole("table", { name: "게시글 목록" });
  await expect(table.locator("tbody tr")).toHaveCount(30);
  const pageOneIds = await table
    .locator('a[href^="/posts/"]')
    .evaluateAll((links) =>
      links.map((link) =>
        new URL((link as HTMLAnchorElement).href).pathname.split("/").pop(),
      ),
    );
  expect(pageOneIds).toEqual(shareIds.slice(0, 30));
  const writeUrl = new URL(
    (await page
      .getByRole("link", { name: "글 쓰기", exact: true })
      .getAttribute("href"))!,
    "http://fixture.test",
  );
  expect(writeUrl.pathname).toBe("/new");
  expect(
    new URL(
      writeUrl.searchParams.get("from")!,
      "http://fixture.test",
    ).searchParams.get("q"),
  ).toBe(query);
  const pagination = page.getByRole("navigation", { name: "목록 페이지" });
  await expect(pagination).toContainText("1 / 2 페이지");
  await pagination.getByRole("link", { name: "다음", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(6);
  await expect(pagination).toContainText("2 / 2 페이지");
  const pageTwoIds = await table
    .locator('a[href^="/posts/"]')
    .evaluateAll((links) =>
      links.map((link) =>
        new URL((link as HTMLAnchorElement).href).pathname.split("/").pop(),
      ),
    );
  expect(pageTwoIds).toEqual(shareIds.slice(30));
  expect(pageTwoIds.some((id) => privateIds.includes(id!))).toBe(false);
  await pagination.getByRole("link", { name: "이전", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(30);
  await expect(pagination).toContainText("1 / 2 페이지");
  await pagination.getByRole("link", { name: "다음", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(6);
  await expect(pagination).toContainText("2 / 2 페이지");
  const feed = new URL(page.url());
  expect(Object.fromEntries(feed.searchParams)).toEqual({
    purpose: "share",
    tag: selectedTag,
    q: query,
    page: "2",
  });
  const article = table.getByRole("link", { name: `${query} 34`, exact: true });
  await article.scrollIntoViewIfNeeded();
  const savedScroll = await page.evaluate(() => window.scrollY);
  expect(savedScroll).toBeGreaterThan(0);
  await article.click();
  await expect(page).toHaveURL(
    (url) => url.pathname === `/posts/${shareIds[34]}`,
  );
  const from = new URL(page.url()).searchParams.get("from");
  expect(from).toBe(`${feed.pathname}${feed.search}`);
  await page
    .getByRole("link", { name: "목록으로 돌아가기", exact: true })
    .click();
  await expect(page).toHaveURL(
    (url) => url.pathname === feed.pathname && url.search === feed.search,
  );
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBe(savedScroll);
  await article.click();
  await expect(page).toHaveURL(
    (url) => url.pathname === `/posts/${shareIds[34]}`,
  );
  await page
    .getByRole("main")
    .getByRole("link", { name: new RegExp(`${tag} 주제 글 보기`, "i") })
    .first()
    .click();
  await expect(page).toHaveURL(
    (url) =>
      [...url.searchParams.keys()].join() === "tag" &&
      url.searchParams.get("tag")?.toLowerCase() === tag,
  );
  await expect(page.locator("#feed-results")).toContainText("공개 글 38개");
  await page.goto(`/?kind=workflow&q=${query}&tag=${tag}`);
  await expect(
    tabs.getByRole("link", { name: "공유", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#feed-results")).toContainText("공개 글 36개");
  await tabs.getByRole("link", { name: "질문", exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("purpose") === "question",
  );
  expect(new URL(page.url()).searchParams.get("kind")).toBeNull();
  expect(new URL(page.url()).searchParams.get("purpose")).toBe("question");
  await expect(page.locator("#feed-results")).toContainText("공개 글 1개");
});

test("외부 html 속성은 허용하되 본문 hydration 오류는 계속 감지한다", async ({
  browser,
  baseURL,
  request,
}) => {
  const response = await request.get("/");
  expect(await response.text()).not.toContain("data-moduboza-companion");

  for (const target of ["html", "body"] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await context.addInitScript((tag) => {
      const inject = () => {
        const element = document.querySelector(tag);
        if (!element) return false;
        element.setAttribute(
          tag === "html" ? "data-moduboza-companion" : "data-hydration-probe",
          "ready",
        );
        return true;
      };
      if (!inject()) {
        const observer = new MutationObserver(() => {
          if (inject()) observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
      }
    }, target);
    await page.goto(baseURL!);
    await page
      .getByRole("navigation", { name: "글 목적" })
      .getByRole("link", { name: "공유", exact: true })
      .click();
    await expect(page).toHaveURL(/purpose=share/);
    if (target === "html") {
      await expect(page.locator("html")).toHaveAttribute(
        "data-moduboza-companion",
        "ready",
      );
      expect(errors).toEqual([]);
    } else {
      await expect
        .poll(() =>
          errors.some(
            (message) =>
              message.includes("hydration-mismatch") &&
              message.includes("data-hydration-probe"),
          ),
        )
        .toBeTruthy();
    }
    await context.close();
  }
});

test("출처·JSON·상위 댓글 검증을 서버에서 적용", async ({
  request,
  playwright,
  baseURL,
}) => {
  const origin = baseURL!;
  await register(request, origin);
  expect(
    (
      await request.post("/api/posts", {
        headers: { Origin: "https://other.example" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/posts", {
        headers: { Origin: origin, "Content-Type": "application/json" },
        data: "{",
      })
    ).status(),
  ).toBe(400);
  const first = await post(request, origin, "원댓글이 있는 글");
  createdPostIds.push(first.result.id);
  const otherAuthor = await playwright.request.newContext({ baseURL: origin });
  await register(otherAuthor, origin);
  const second = await post(otherAuthor, origin, "다른 글");
  createdPostIds.push(second.result.id);
  const rootResponse = await request.post(
    `/api/posts/${first.result.id}/comments`,
    {
      headers: { Origin: origin },
      data: { body: "이 글에 남기는 원댓글입니다." },
    },
  );
  expect(rootResponse.status()).toBe(201);
  const root = await rootResponse.json();
  const crossPost = await otherAuthor.post(
    `/api/posts/${second.result.id}/comments`,
    {
      headers: { Origin: origin },
      data: { body: "다른 글의 댓글을 참조합니다.", parentId: root.id },
    },
  );
  expect(crossPost.status()).toBe(400);
  const replyResponse = await otherAuthor.post(
    `/api/posts/${first.result.id}/comments`,
    {
      headers: { Origin: origin },
      data: { body: "원댓글에 남기는 답글입니다.", parentId: root.id },
    },
  );
  expect(replyResponse.status()).toBe(201);
  const reply = await replyResponse.json();
  const nested = await request.post(`/api/posts/${first.result.id}/comments`, {
    headers: { Origin: origin },
    data: { body: "답글의 답글은 허용하지 않습니다.", parentId: reply.id },
  });
  expect(nested.status()).toBe(400);
  await otherAuthor.dispose();
});
