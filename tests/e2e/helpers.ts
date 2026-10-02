import { expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export async function register(request: APIRequestContext, origin: string) {
  const email = `member-${randomUUID()}@example.com`;
  const response = await request.post("/api/auth/sign-up/email", {
    headers: { Origin: origin },
    data: {
      name: "검증회원",
      email,
      password: "Test-only-passphrase-42!",
    },
  });
  expect(response.ok()).toBeTruthy();
  await verifyAndLogin(request, origin, email);
  return response;
}

export async function verifyAndLogin(
  request: APIRequestContext,
  origin: string,
  email: string,
) {
  const mode = ["pass", "hold", "error"][Number(new URL(origin).port) - 3141];
  const mailbox = resolve(
    `data/e2e-${process.env.FORUM_E2E_RUN_ID}-${mode}/mail.jsonl`,
  );
  const messages = readFileSync(mailbox, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const link = messages.findLast(
    (item) => item.email === email && !item.reset,
  )?.url;
  expect(link).toBeTruthy();
  expect(new URL(link).origin).toBe(origin);
  expect((await request.get(link)).ok()).toBeTruthy();
  const login = await request.post("/api/auth/sign-in/email", {
    headers: { Origin: origin },
    data: { email, password: "Test-only-passphrase-42!" },
  });
  expect(login.ok()).toBeTruthy();
}

export async function post(
  request: APIRequestContext,
  origin: string,
  title = "테스트용 분석 질문",
) {
  const response = await request.post("/api/posts", {
    headers: { Origin: origin },
    data: {
      title,
      body: "Ghidra에서 확인한 함수 호출 관계를 함께 검토하고 싶습니다.",
      kind: "question",
      tags: ["Ghidra"],
    },
  });
  expect(response.ok()).toBeTruthy();
  return {
    response,
    result: (await response.json()) as { id: string; status: string },
  };
}
