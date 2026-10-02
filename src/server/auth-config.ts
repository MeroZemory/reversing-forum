import { betterAuth } from "better-auth";
import "./auth-environment";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  getOAuthState,
} from "better-auth/api";
import { randomUUID } from "node:crypto";
import { googleConfigured, mailConfigured, sendAuthMail } from "./auth-mail";
import {
  allowMail,
  consumeVerification,
  registerVerification,
  validateNickname,
  markNickname,
  GOOGLE_PLACEHOLDER,
  FRESH_SECONDS,
  isFresh,
  remainingLoginMethod,
} from "./auth-policy";
import { db } from "./db";
import { testMailboxPath } from "./auth-test-mailbox";

const secret = process.env.BETTER_AUTH_SECRET;
const baseURL = process.env.BETTER_AUTH_URL;
if (!secret || secret.length < 32)
  throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
if (!baseURL) throw new Error("BETTER_AUTH_URL is required.");
const url = new URL(baseURL);
if (!["http:", "https:"].includes(url.protocol))
  throw new Error("Invalid BETTER_AUTH_URL.");
export const auth = betterAuth({
  database: db,
  secret,
  baseURL,
  trustedOrigins: [url.origin],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    autoSignIn: false,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 1800,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      if (allowMail(user.email)) await sendAuthMail(user.email, url, true);
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: false,
    expiresIn: 3600,
    autoSignInAfterVerification: false,
    sendVerificationEmail: async ({ user, url }) => {
      if (!allowMail(user.email)) return;
      // Native JWTs issued in the same second can be identical. Add a signed,
      // unique nonce using the native token factory before recording one-use.
      const { createEmailVerificationToken } = await import("better-auth/api");
      const token = await createEmailVerificationToken(
        secret!,
        user.email,
        undefined,
        3600,
        { nonce: randomUUID() },
      );
      const link = new URL(url);
      link.searchParams.set("token", token);
      registerVerification(token);
      await sendAuthMail(user.email, link.href);
    },
  },
  socialProviders: googleConfigured()
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          mapProfileToUser: () => ({ name: GOOGLE_PLACEHOLDER, image: "" }),
        },
      }
    : {},
  user: {
    validateUserInfo: async ({ user, source }, ctx) => {
      if (source.method !== "oauth") return;
      if (source.oauth?.providerId !== "google" || user.emailVerified !== true)
        return {
          error: "email_not_verified",
          errorDescription: "인증된 Google 이메일이 필요합니다.",
        };
      const state = await getOAuthState();
      if (source.action === "link-account" && state?.link) {
        const session = await getSessionFromCtx(ctx);
        if (
          !session ||
          session.user.id !== state.link.userId ||
          !isFresh(session.session.createdAt)
        )
          return {
            error: "session_not_fresh",
            errorDescription: "다시 로그인한 뒤 Google을 연결해 주세요.",
          };
      }
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: [],
      requireLocalEmailVerified: true,
      allowDifferentEmails: true,
      updateUserInfoOnLink: false,
    },
    encryptOAuthTokens: true,
  },
  session: { freshAge: FRESH_SECONDS, cookieCache: { enabled: false } },
  logger: { disabled: true },
  rateLimit: {
    // The isolated headless mailbox exercises member flows separately from
    // the native HTTP-limit tests. Production always keeps this enabled.
    enabled: !testMailboxPath(),
    window: 60,
    max: 30,
    customRules: {
      "/send-verification-email": { window: 60, max: 3 },
      "/request-password-reset": { window: 60, max: 3 },
      "/sign-up/email": { window: 60, max: 3 },
    },
  },
  onAPIError: { errorURL: `${url.origin}/account?error=auth_failed` },
  databaseHooks: {
    user: {
      create: {
        before: async (user, ctx) => {
          if (ctx?.path === "/sign-up/email")
            return { data: { ...user, name: validateNickname(user.name) } };
          return { data: user };
        },
        after: async (user, ctx) => {
          markNickname(user.id, ctx?.path === "/sign-up/email");
        },
      },
      update: {
        after: async (user, ctx) => {
          if (
            ctx?.path === "/update-user" &&
            typeof ctx.body?.name === "string"
          )
            markNickname(user.id, true);
        },
      },
    },
    account: {
      create: {
        before: async (account, ctx) => {
          if (account.providerId === "google" && ctx) {
            const state = await getOAuthState();
            if (state?.link) {
              const session = await getSessionFromCtx(ctx);
              if (
                !session ||
                session.user.id !== state.link.userId ||
                !isFresh(session.session.createdAt)
              )
                throw new APIError("FORBIDDEN", {
                  message: "다시 로그인한 뒤 Google을 연결해 주세요.",
                });
            }
          }
          return { data: account };
        },
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      for (const key of [
        "callbackURL",
        "errorCallbackURL",
        "newUserCallbackURL",
        "redirectTo",
      ]) {
        const value = ctx.body?.[key];
        if (value !== undefined) {
          let valid = false;
          try {
            valid =
              typeof value === "string" &&
              new URL(value, url.origin).origin === url.origin;
          } catch {
            /* reject malformed URL */
          }
          if (!valid)
            throw new APIError("FORBIDDEN", {
              message: "이 사이트 안의 복귀 주소가 필요합니다.",
            });
        }
      }
      if (
        [
          "/sign-up/email",
          "/send-verification-email",
          "/request-password-reset",
        ].includes(ctx.path) &&
        !mailConfigured()
      )
        throw new APIError("SERVICE_UNAVAILABLE", {
          message:
            "메일 전송을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
          code: "MAIL_UNAVAILABLE",
        });
      if (
        ctx.path === "/verify-email" &&
        !consumeVerification(String(ctx.query?.token || ""))
      ) {
        if (ctx.request)
          throw ctx.redirect(`${url.origin}/verify-email?error=invalid_token`);
        throw new APIError("BAD_REQUEST", {
          message:
            "만료되었거나 사용한 링크입니다. 인증 메일을 다시 요청해 주세요.",
          code: "INVALID_TOKEN",
        });
      }
      if (ctx.path === "/send-verification-email") {
        const session = await getSessionFromCtx(ctx);
        if (
          session &&
          (session.user.emailVerified ||
            session.user.email.toLowerCase() !== ctx.body.email.toLowerCase())
        )
          return ctx.json({ status: true });
      }
      if (
        ctx.path === "/sign-up/email" ||
        (ctx.path === "/update-user" && ctx.body?.name !== undefined)
      ) {
        try {
          ctx.body.name = validateNickname(ctx.body.name);
        } catch {
          throw new APIError("BAD_REQUEST", {
            message: "닉네임은 2~30자로 입력해 주세요.",
          });
        }
      }
      if (["/link-social", "/unlink-account"].includes(ctx.path)) {
        const session = await getSessionFromCtx(ctx);
        if (!session || !isFresh(session.session.createdAt))
          throw new APIError("FORBIDDEN", {
            message: "다시 로그인한 뒤 계정을 변경해 주세요.",
            code: "SESSION_NOT_FRESH",
          });
        if (
          ctx.path === "/link-social" &&
          (ctx.body?.provider !== "google" || ctx.body?.idToken)
        )
          throw new APIError("BAD_REQUEST", {
            message: "Google 브라우저 인증으로 연결해 주세요.",
          });
        if (ctx.path === "/unlink-account") {
          const accounts = await ctx.context.internalAdapter.findAccounts(
            session.user.id,
          );
          // This account UI manages Google links only. Preserve the credential
          // account so concurrent requests cannot each remove the other's fallback.
          if (
            accounts.find((a) => a.id === ctx.body.accountId)?.providerId !==
            "google"
          )
            throw new APIError("BAD_REQUEST", {
              message: "Google 연결만 해제할 수 있습니다.",
            });
          if (
            !remainingLoginMethod(
              accounts,
              ctx.body.accountId,
              session.user.emailVerified,
            )
          )
            throw new APIError("BAD_REQUEST", {
              message: "사용 가능한 다른 로그인 수단을 먼저 추가해 주세요.",
            });
        }
      }
    }),
  },
});
