import { authClient } from "@/lib/auth-client";
import type {
  AuthCommand,
  AuthMode,
  AccountData,
} from "@/lib/interaction-types";
import { safeAuthReturn } from "@/lib/format";
export async function authenticate(
  mode: AuthMode,
  command: AuthCommand,
  returnTo?: string,
): Promise<boolean> {
  const credentials = { email: command.email, password: command.password };
  const result =
    mode === "register"
      ? await authClient.signUp.email({
          ...credentials,
          name: command.name || "",
          callbackURL: `/verify-email?verified=1&returnTo=${encodeURIComponent(safeAuthReturn(returnTo))}`,
        })
      : await authClient.signIn.email(credentials);
  return !result.error;
}
export async function getPublicAuthConfig(): Promise<{
  googleEnabled: boolean;
  mailEnabled: boolean;
}> {
  const response = await fetch("/api/auth/public-config", {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("인증 설정을 불러오지 못했습니다.");
  return response.json();
}
export async function googleSignIn(
  returnTo?: string,
  linking = false,
  authPath: "/login" | "/register" = "/login",
) {
  const callbackURL = linking ? "/account" : safeAuthReturn(returnTo);
  const result = linking
    ? await authClient.linkSocial({
        provider: "google",
        callbackURL,
        errorCallbackURL: "/account?error=auth_failed",
      })
    : await authClient.signIn.social({
        provider: "google",
        callbackURL,
        newUserCallbackURL: `/onboarding?returnTo=${encodeURIComponent(callbackURL)}`,
        errorCallbackURL: `${authPath}?error=google_auth_failed&returnTo=${encodeURIComponent(callbackURL)}`,
      });
  if (result.error)
    throw new Error(
      result.error.message || "Google 인증을 시작하지 못했습니다.",
    );
}
export async function loadAccount(): Promise<AccountData | null> {
  const response = await fetch("/api/auth/account-status", {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("계정 정보를 불러오지 못했습니다.");
  return response.json();
}
export async function requestVerification(email: string, returnTo?: string) {
  const result = await authClient.sendVerificationEmail({
    email,
    callbackURL: `/verify-email?verified=1&returnTo=${encodeURIComponent(safeAuthReturn(returnTo))}`,
  });
  if (result.error)
    throw new Error(result.error.message || "인증 메일을 요청하지 못했습니다.");
}
export async function requestReset(email: string) {
  const result = await authClient.requestPasswordReset({
    email,
    redirectTo: "/reset-password",
  });
  if (result.error)
    throw new Error(
      result.error.message || "재설정 메일을 요청하지 못했습니다.",
    );
}
export async function resetPassword(token: string, newPassword: string) {
  const result = await authClient.resetPassword({ token, newPassword });
  if (result.error)
    throw new Error(
      "만료되었거나 사용한 링크입니다. 재설정 메일을 다시 요청해 주세요.",
    );
}
export async function updateNickname(name: string) {
  const result = await authClient.updateUser({ name });
  if (result.error)
    throw new Error(result.error.message || "닉네임을 저장하지 못했습니다.");
}
export async function setPassword(newPassword: string) {
  const response = await fetch("/api/account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newPassword }),
  });
  if (!response.ok) throw new Error((await response.json()).error);
}
export async function unlinkGoogle(accountId: string) {
  const result = await authClient.unlinkAccount({ accountId });
  if (result.error)
    throw new Error(
      result.error.message || "Google 연결을 해제하지 못했습니다.",
    );
}
export async function signOut(): Promise<boolean> {
  return !(await authClient.signOut()).error;
}
