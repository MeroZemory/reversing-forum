import { expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

export async function register(request: APIRequestContext, origin: string) {
  const response = await request.post("/api/auth/sign-up/email", {
    headers: { Origin: origin },
    data: {
      name: "검증회원",
      email: `member-${randomUUID()}@example.com`,
      password: "Test-only-passphrase-42!",
    },
  });
  expect(response.ok()).toBeTruthy();
  return response;
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
