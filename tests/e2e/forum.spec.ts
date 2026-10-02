import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { basename, dirname, resolve } from "node:path";
import { register, post } from "./helpers";

test("목록 탭·검색·뒤로가기의 상태와 스크롤을 유지한다", async ({
  page,
}, info) => {
  const databasePath = String(info.project.metadata.databasePath);
  // Fixtures belong only to this run's isolated database, never the preview DB.
  expect(dirname(databasePath)).toBe(resolve("data"));
  expect(basename(databasePath)).toMatch(/^e2e-[a-f0-9]+-pass\.sqlite$/);
  const db = new Database(databasePath);
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
        page.getByRole("navigation", { name: "글 유형", exact: true }),
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
        name: "글 유형",
        exact: true,
      });
      const analysis = tabs.getByRole("link", { name: "분석", exact: true });
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
      await expect(page).toHaveURL(/kind=analysis/);
      await expect(analysis).toHaveAttribute("aria-current", "page");
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
      await page.getByRole("textbox", { name: "글 검색" }).fill("목록검수");
      await page.getByRole("button", { name: "검색", exact: true }).click();
      await expect(page).toHaveURL(/kind=analysis&q=/);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
      await expect(
        page.getByRole("table", { name: "게시글 목록" }),
      ).toBeVisible();
      await tabs.getByRole("link", { name: "질문", exact: true }).click();
      await expect(page).toHaveURL(/kind=question&q=/);
      await expect(page.getByRole("textbox", { name: "글 검색" })).toHaveValue(
        "목록검수",
      );
      await expect(skipLink).not.toBeInViewport();
      await expect(
        page.getByRole("heading", { name: "질문 글", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "검색어 지우기", exact: true })
        .click();
      await expect(page).toHaveURL(/\?kind=question$/);
      await expect(page.getByRole("textbox", { name: "글 검색" })).toHaveValue(
        "",
      );
      await page.goBack();
      await expect(page).toHaveURL(/kind=question&q=/);
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
    await expect(page.getByRole("table", { name: "게시글 목록" })).toHaveCount(
      0,
    );
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
        .getByRole("navigation", { name: "글 유형" })
        .getByRole("link", { name: "분석", exact: true }),
      page.getByRole("button", { name: "검색", exact: true }),
    ]) {
      const box = await control.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    const listHeading = await page
      .getByRole("heading", { name: "최신 글", exact: true })
      .boundingBox();
    expect(listHeading!.y).toBeLessThan(310);
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

  await page.goto("/?kind=analysis&q=missing-search-fixture");
  await expect(page.getByRole("status")).toContainText(
    "검색어에 맞는 글이 없습니다.",
  );
  await page.getByRole("link", { name: "검색어 지우기", exact: true }).click();
  await expect(page).toHaveURL(/\?kind=analysis$/);
  await expect(page.getByRole("status")).toContainText(
    "아직 공개된 분석 글이 없습니다.",
  );
  await page.getByRole("link", { name: "전체 글 보기", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/`);
  await page.goto("/?kind=analysis&q=missing-search-fixture");
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
  await page.getByLabel("비밀번호").fill("Test-only-passphrase-42!");
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
  await expect(page).toHaveURL(`${origin}/new`);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByLabel("제목", { exact: true })).toBeVisible();
    if (width <= 390) {
      await expect(page.getByLabel("태그", { exact: false })).toBeInViewport();
    }
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
  await page
    .getByRole("combobox", { name: "글 유형", exact: true })
    .selectOption("analysis");
  await page.getByLabel("제목", { exact: true }).fill(title);
  await page
    .getByLabel("본문", { exact: true })
    .fill(
      "Ghidra로 PE 파일의 함수 호출 관계를 확인한 과정을 공유합니다. 재현 환경과 관찰한 결과를 함께 남깁니다.",
    );
  await page.getByLabel("태그", { exact: false }).fill("Windows, Ghidra");
  await page.getByRole("button", { name: "글 등록하기" }).click();
  await expect(page).toHaveURL(/\/posts\/[a-f0-9-]+$/);
  const postUrl = page.url();
  const id = postUrl.split("/").pop()!;
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
  await page
    .getByLabel("첫번째회원님에게 답글")
    .fill("추가로 확인한 내용은 답글로 이어갑니다.");
  // The real comment flood limit requires five seconds between writes.
  await page.waitForTimeout(5100);
  await page.getByRole("button", { name: "답글 등록", exact: true }).click();
  await expect(
    page.getByText("추가로 확인한 내용은 답글로 이어갑니다.", { exact: true }),
  ).toBeVisible();
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
    await expect(
      page.getByRole("heading", { name: "댓글 2", exact: true }),
    ).toBeInViewport();
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
      .getByRole("navigation", { name: "글 유형" })
      .getByRole("link", { name: "분석", exact: true })
      .click();
    await expect(page).toHaveURL(/kind=analysis/);
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
  const otherAuthor = await playwright.request.newContext({ baseURL: origin });
  await register(otherAuthor, origin);
  const second = await post(otherAuthor, origin, "다른 글");
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
