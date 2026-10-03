import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { createServer } from "node:net";

const phase = process.argv[2] || "latest";
if (!/^[a-z0-9-]+$/i.test(phase))
  throw new Error("Invalid UI verification name.");
const out = resolve(`data/ui-ux/${phase}`);
mkdirSync(out, { recursive: true });
await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", () =>
    reject(new Error("UI verification port 3150 is already in use.")),
  );
  probe.listen(3150, "127.0.0.1", () => probe.close(resolve));
});
const origin = "http://127.0.0.1:3150";
const env = {
  ...process.env,
  DATABASE_PATH: resolve(`data/ui-ux/${phase}-${Date.now()}.sqlite`),
  BETTER_AUTH_SECRET: randomBytes(48).toString("base64"),
  BETTER_AUTH_URL: origin,
  SITE_URL: origin,
  NEXT_DIST_DIR: ".next-verification/ui-audit",
  NODE_PATH: resolve("node_modules"),
  JEV_MOCK: "pass",
  DUPLICATE_MOCK: "distinct",
  AUTH_CONFIG_FILE: "",
  RESEND_API_KEY: "",
  RESEND_FROM: "",
  FORUM_AUTH_TEST_MAILBOX: resolve(
    `data/ui-ux/${phase}-${Date.now()}.mail.jsonl`,
  ),
};
const init = spawnSync(
  process.execPath,
  ["--env-file=.env", "--import", "tsx", "scripts/init-db.ts"],
  { env, windowsHide: true, encoding: "utf8" },
);
if (init.status !== 0) throw new Error("Audit database initialization failed.");
const log = openSync(`${out}/server.log`, "w");
const server = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3150",
  ],
  { env, windowsHide: true, stdio: ["ignore", log, log] },
);
let browser;
let db;
const evidence = { phase, pages: [], errors: [], expectedErrors: [] };
try {
  for (let attempt = 0; ; attempt++) {
    if (server.exitCode !== null)
      throw new Error("UI verification server stopped before becoming ready.");
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    if (attempt > 100) throw new Error("Audit server did not become ready.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  browser = await chromium.launch({ headless: true });
  const guest = await browser.newContext();
  const page = await guest.newPage();
  let expectingErrors = false;
  page.on("pageerror", (error) => evidence.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      const expected404 =
        new URL(page.url()).pathname === "/posts/missing-audit" &&
        message.text().includes("404");
      (expectingErrors || expected404
        ? evidence.expectedErrors
        : evidence.errors
      ).push(message.text());
    }
  });
  async function capture(target, name, widths = [1440, 390, 320]) {
    for (const width of widths) {
      await target.setViewportSize({
        width,
        height: width >= 768 ? 1000 : 844,
      });
      await target.evaluate(() =>
        window.scrollTo({ top: 0, behavior: "instant" }),
      );
      await target.waitForFunction(() => document.getAnimations().length > 0);
      await target.evaluate(() => document.fonts.ready);
      await target.screenshot({
        path: `${out}/${name}-${width}.png`,
        fullPage: true,
        caret: "initial",
      });
      evidence.pages.push({
        name,
        width,
        url: target.url().replace(origin, ""),
        ...(await target.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          headings: [...document.querySelectorAll("main h1")].map(
            (h) => h.textContent,
          ),
        }))),
      });
    }
  }
  await page.goto(origin);
  await capture(page, "home-empty");
  db = new Database(env.DATABASE_PATH);
  const titles = [
    "Ghidra에서 함수 호출 관계를 따라가며 확인한 것",
    "패킹된 실행 파일의 진입점에서 막혔습니다",
    "AI가 제시한 의사코드를 실제 어셈블리와 비교하기",
    "Frida로 Android 앱의 함수 인자를 관찰하는 방법",
    "WinDbg로 예외 발생 직전의 스택을 확인하기",
    "처음 리버싱을 시작할 때 어떤 도구부터 써 보셨나요?",
  ];
  const body =
    "PE 파일의 함수 호출 관계를 확인한 과정을 공유합니다.\n\n## 분석 환경\nWindows 11 · Ghidra · 직접 만든 실습용 바이너리\n\n## 관찰한 내용\n디컴파일 결과와 실제 분기 조건을 비교했습니다.\n\n```asm\nmov eax, [rbp-0x10]\ncmp eax, 0x2a\njne short loc_140001070\n```\n\n추측한 부분은 실제 실행 결과와 구분해 적었습니다. 다른 환경에서 재현했다면 댓글로 알려 주세요.";
  const insert = db.prepare(
    "INSERT INTO posts(id,author_id,author_name,title,body,kind,tags,status,created_at) VALUES(?,?,?,?,?,?,?,'published',?)",
  );
  db.transaction(() => {
    for (let i = 0; i < 54; i++)
      insert.run(
        `audit-${i}`,
        "audit-author",
        i % 3 ? "함수추적자" : "길이가긴닉네임으로도레이아웃검수",
        titles[i % titles.length],
        body,
        [
          "analysis",
          "question",
          "workflow",
          "analysis",
          "question",
          "discussion",
        ][i % 6],
        JSON.stringify(
          i % 3 === 0
            ? ["Ghidra", "Windows"]
            : i % 3 === 1
              ? ["Windows", "WinDbg"]
              : ["AI", "Ghidra"],
        ),
        new Date(Date.now() - i * 100000).toISOString(),
      );
  })();
  await page.goto(origin);
  await capture(page, "home-populated", [1440, 768, 390, 320]);
  await page.goto(`${origin}/?q=검색결과없음`);
  await capture(page, "search-empty");
  await page.goto(`${origin}/posts/audit-0`);
  await capture(page, "article-guest");
  if (phase !== "before") {
    await page.goto(`${origin}/?purpose=share&tag=Ghidra&q=cmp`);
    await capture(page, "feed-filtered");
    await page.goto(`${origin}/?page=2`);
    await capture(page, "feed-page-two");
    await page.goto(origin);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".topic-disclosure summary").click();
    await capture(page, "topics-open", [390, 320]);
  }
  for (const path of [
    "/login?returnTo=%2Fnew",
    "/register?returnTo=%2Fnew",
    "/posts/missing-audit",
  ]) {
    await page.goto(`${origin}${path}`);
    await capture(
      page,
      path.includes("register")
        ? "register"
        : path.includes("login")
          ? "login"
          : "not-found",
    );
  }
  if (phase !== "before") {
    await page.goto(`${origin}/login?returnTo=%2Fnew`);
    await page
      .getByLabel("이메일", { exact: true })
      .fill("missing-audit@example.com");
    await page
      .getByLabel("비밀번호", { exact: true })
      .fill("invalid-audit-password");
    expectingErrors = true;
    await page
      .getByRole("button", { name: "이메일로 로그인", exact: true })
      .click();
    await page.locator("#auth-error").waitFor();
    await page.waitForFunction(
      () => document.querySelector("#auth-error") === document.activeElement,
    );
    assert(
      await page
        .locator("#auth-error")
        .evaluate((el) => el === document.activeElement),
    );
    await capture(page, "login-error");
    expectingErrors = false;
  }
  const member = await browser.newContext();
  const auditEmail = `audit-${Date.now()}@example.com`;
  const auditPassword = randomBytes(24).toString("hex");
  const registration = await member.request.post(
    `${origin}/api/auth/sign-up/email`,
    {
      headers: { Origin: origin },
      data: {
        name: "검수회원",
        email: auditEmail,
        password: auditPassword,
      },
    },
  );
  if (!registration.ok()) throw new Error("Audit account creation failed.");
  const user = (await registration.json()).user;
  const captured = readFileSync(env.FORUM_AUTH_TEST_MAILBOX, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const link = captured.findLast(
    (item) => item.email === auditEmail && !item.reset,
  )?.url;
  assert(link && new URL(link).origin === origin);
  assert((await member.request.get(link)).ok());
  assert(
    (
      await member.request.post(`${origin}/api/auth/sign-in/email`, {
        headers: { Origin: origin },
        data: { email: auditEmail, password: auditPassword },
      })
    ).ok(),
  );
  const memberPage = await member.newPage();
  memberPage.on("pageerror", (error) => evidence.errors.push(error.message));
  for (const path of ["/me", "/new", "/posts/audit-0"]) {
    await memberPage.goto(`${origin}${path}`);
    await capture(
      memberPage,
      path === "/me"
        ? "my-empty"
        : path === "/new"
          ? "editor"
          : "article-member",
    );
  }
  if (phase !== "before") {
    await memberPage.goto(`${origin}/new?purpose=share&tag=Ghidra`);
    await memberPage
      .getByLabel("제목", { exact: true })
      .fill("디컴파일 결과와 분기 조건을 비교했습니다");
    await memberPage.getByLabel("본문", { exact: true }).fill(body);
    await memberPage
      .getByRole("button", { name: "미리보기", exact: true })
      .click();
    await capture(memberPage, "editor-preview");
    await memberPage.reload();
    await memberPage.waitForFunction(
      (expected) =>
        document.querySelector('textarea[name="body"]')?.value === expected,
      body,
    );
    assert.equal(
      await memberPage.getByLabel("본문", { exact: true }).inputValue(),
      body,
    );
    await capture(memberPage, "editor-draft");
    const comment = db.prepare(
      "INSERT INTO comments(id,post_id,parent_id,author_id,author_name,body,created_at) VALUES(?,?,?,?,?,?,?)",
    );
    comment.run(
      "audit-comment-root",
      "audit-0",
      null,
      user.id,
      user.name,
      "분기 조건을 직접 실행해 보니 같은 결과가 나왔습니다. 근거가 되는 레지스터 값도 함께 확인했습니다.",
      new Date().toISOString(),
    );
    comment.run(
      "audit-comment-reply",
      "audit-0",
      "audit-comment-root",
      "audit-reader",
      "스택을따라서",
      "이전 버전에서도 재현되는지 확인해 보겠습니다.",
      new Date().toISOString(),
    );
    await memberPage.goto(`${origin}/posts/audit-0`);
    await memberPage.getByRole("button", { name: "답글", exact: true }).click();
    await memberPage
      .getByLabel(`${user.name}님에게 답글`, { exact: true })
      .waitFor();
    await capture(memberPage, "article-reply");
  }
  const privateInsert = db.prepare(
    "INSERT INTO posts(id,author_id,author_name,title,body,kind,tags,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  for (const status of ["pending", "held", "published"])
    privateInsert.run(
      `mine-${status}`,
      user.id,
      user.name,
      `내가 작성한 ${status} 상태의 글`,
      body,
      "question",
      JSON.stringify(["Ghidra"]),
      status,
      new Date().toISOString(),
    );
  await memberPage.goto(`${origin}/me`);
  await capture(memberPage, "my-populated");
  await memberPage.goto(`${origin}/posts/mine-held`);
  await capture(memberPage, "article-private");
  if (phase !== "before") {
    await memberPage.goto(`${origin}/posts/mine-pending`);
    await capture(memberPage, "article-pending");
    await memberPage.goto(`${origin}/me?status=held`);
    await capture(memberPage, "my-held");
    privateInsert.run(
      "audit-broken",
      "audit-author",
      "검수",
      "오류 복구 흐름",
      body,
      "analysis",
      "broken-json",
      "published",
      new Date().toISOString(),
    );
    expectingErrors = true;
    await page.goto(`${origin}/posts/audit-broken`);
    await page
      .getByRole("heading", {
        name: "페이지를 불러오지 못했습니다.",
        exact: true,
      })
      .waitFor();
    await capture(page, "error");
    db.prepare("UPDATE posts SET tags=? WHERE id=?").run("[]", "audit-broken");
    await page
      .getByRole("button", { name: "다시 시도하기", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "오류 복구 흐름", exact: true })
      .waitFor();
    expectingErrors = false;
  }
  writeFileSync(`${out}/verification.json`, JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify(
      {
        phase,
        captures: evidence.pages.length,
        overflow: evidence.pages.filter((p) => p.overflow),
        errors: evidence.errors,
      },
      null,
      2,
    ),
  );
  assert.equal(
    evidence.errors.length,
    0,
    "Unexpected browser errors during UI review.",
  );
  assert.equal(
    evidence.pages.filter((page) => page.overflow).length,
    0,
    "Horizontal overflow during UI review.",
  );
} finally {
  db?.close();
  await browser?.close();
  server.kill();
}
