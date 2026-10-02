import "server-only";
import { auth } from "./auth-config";
import { isFresh, nicknameReady, GOOGLE_PLACEHOLDER } from "./auth-policy";
import { googleConfigured, mailConfigured } from "./auth-mail";

export async function accountSnapshot(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const context = await auth.$context;
  const accounts = await context.internalAdapter.findAccounts(session.user.id);
  const ready = nicknameReady(session.user.id);
  return {
    name: ready ? session.user.name : GOOGLE_PLACEHOLDER,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
    nicknameReady: ready,
    fresh: isFresh(session.session.createdAt),
    hasPassword: accounts.some(
      (a) => a.providerId === "credential" && Boolean(a.password),
    ),
    googleAccountId:
      accounts.find((a) => a.providerId === "google")?.id ?? null,
    googleEnabled: googleConfigured(),
    mailEnabled: mailConfigured(),
  };
}
export async function setInitialPassword(
  headers: Headers,
  newPassword: unknown,
) {
  const session = await auth.api.getSession({ headers });
  if (
    !session ||
    !session.user.emailVerified ||
    !isFresh(session.session.createdAt)
  )
    throw new Error(
      "이메일 인증과 최근 로그인이 필요합니다. 다시 로그인해 주세요.",
    );
  if (
    typeof newPassword !== "string" ||
    newPassword.length < 10 ||
    newPassword.length > 128
  )
    throw new Error("비밀번호는 10~128자로 입력해 주세요.");
  await auth.api.setPassword({ headers, body: { newPassword } });
}
