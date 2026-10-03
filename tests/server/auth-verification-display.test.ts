import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { AccountFlowState } from "@/lib/interaction-types";
import { AccountFlowView } from "@/components/account-flow";
import { AccountFlow } from "@/features/account-flow";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

function state(overrides: Partial<AccountFlowState>): AccountFlowState {
  return {
    mode: "verify",
    busy: false,
    error: "",
    notice: "",
    account: null,
    email: "",
    submit: async () => {},
    linkGoogle: async () => {},
    unlinkGoogle: async () => {},
    ...overrides,
  };
}

it("shows one clear login action after verification instead of another email request", () => {
  const html = renderToStaticMarkup(
    createElement(AccountFlow, {
      mode: "verify",
      verified: true,
      returnTo: "/new?kind=question",
    }),
  );
  expect(html).toContain("이메일 인증 완료");
  expect(html).toContain('role="status"');
  expect(html).toContain('href="/login?returnTo=%2Fnew%3Fkind%3Dquestion"');
  expect(html).not.toContain("<form");
  expect(html).not.toContain("메일 요청");
  expect(html).not.toContain('type="email"');
});

it("shows an authenticated member their next destination when email ownership is already verified", () => {
  const html = renderToStaticMarkup(
    createElement(AccountFlowView, {
      state: state({
        verificationStatus: "already-verified",
        continueHref: "/new",
        account: {
          name: "검수 회원",
          email: "synthetic@example.test",
          emailVerified: true,
          nicknameReady: true,
          fresh: true,
          hasPassword: true,
          googleAccountId: null,
          googleEnabled: false,
          mailEnabled: true,
        },
      }),
    }),
  );
  expect(html).toContain("이미 인증되어 있습니다");
  expect(html).toContain('href="/new"');
  expect(html).toContain("계속하기");
  expect(html).not.toContain("메일 요청");
  expect(html).not.toContain("로그인하기");
});

it("keeps an error recovery form without claiming success when the redirect includes an error", () => {
  const html = renderToStaticMarkup(
    createElement(AccountFlow, {
      mode: "verify",
      verified: true,
      error: "INVALID_TOKEN",
    }),
  );
  expect(html).toContain("<form");
  expect(html).toContain('role="alert"');
  expect(html).toContain("인증 링크가 만료되었거나 이미 사용되었습니다");
  expect(html).not.toContain("이메일 인증 완료");
  expect(html).not.toContain("이메일 인증을 완료했습니다");
});

it("retains the mail request for an unverified guest", () => {
  const html = renderToStaticMarkup(
    createElement(AccountFlow, { mode: "verify" }),
  );
  expect(html).toContain('type="email"');
  expect(html).toContain("메일 요청");
  expect(html).not.toContain("이메일 인증 완료");
});
