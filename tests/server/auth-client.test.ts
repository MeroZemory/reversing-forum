import { beforeEach, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ social: vi.fn(), link: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { social: client.social }, linkSocial: client.link },
}));
import { googleSignIn } from "@/client/auth-service";
beforeEach(() => {
  client.social.mockReset().mockResolvedValue({ data: {}, error: null });
  client.link.mockReset().mockResolvedValue({ data: {}, error: null });
});
it("keeps Google sign-in callbacks on site and returns errors to the originating auth page", async () => {
  await googleSignIn("https://external.invalid", false, "/register");
  expect(client.social).toHaveBeenCalledWith({
    provider: "google",
    callbackURL: "/",
    newUserCallbackURL: "/onboarding?returnTo=%2F",
    errorCallbackURL: "/register?error=google_auth_failed&returnTo=%2F",
  });
  await googleSignIn("/new?kind=analysis");
  expect(client.social).toHaveBeenLastCalledWith(
    expect.objectContaining({
      callbackURL: "/new?kind=analysis",
      errorCallbackURL:
        "/login?error=google_auth_failed&returnTo=%2Fnew%3Fkind%3Danalysis",
    }),
  );
});
it("keeps manual linking and its callback errors in account management", async () => {
  await googleSignIn("https://external.invalid", true);
  expect(client.link).toHaveBeenCalledWith({
    provider: "google",
    callbackURL: "/account",
    errorCallbackURL: "/account?error=auth_failed",
  });
  expect(client.social).not.toHaveBeenCalled();
});
it("reports an OAuth-start failure so the UI can clear pending state", async () => {
  client.social.mockResolvedValue({
    error: { message: "Google 인증을 시작하지 못했습니다." },
  });
  await expect(googleSignIn("/new")).rejects.toThrow(
    "Google 인증을 시작하지 못했습니다.",
  );
});
