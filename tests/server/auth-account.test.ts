import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
const viewerContext = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => viewerContext.headers }));

let auth: (typeof import("@/server/auth-config"))["auth"];
let db: (typeof import("@/server/db"))["db"];
let policy: typeof import("@/server/auth-policy");
let account: typeof import("@/server/auth-account");
let provider: Awaited<typeof auth.$context>["socialProviders"][number];
let identity = {
  sub: "google-owner",
  email: "google@example.test",
  email_verified: true,
  name: "Private Legal Name",
};
const origin = "http://localhost:3000";
const password = "test-password-12345";
const mails: { to: string[]; text: string }[] = [];
const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
  mails.push(JSON.parse(String(init?.body)));
  return Response.json({ id: "synthetic-mail" });
});
async function post(path: string, body: unknown, cookie = "") {
  return auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
}
function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}
function mailURL() {
  const link = mails
    .at(-1)!
    .text.split(/\s+/)
    .find((part) => /^https?:\/\//.test(part));
  if (!link) throw new Error("Authentication mail must contain a link.");
  return new URL(link);
}
async function signup(email: string) {
  return post("/sign-up/email", {
    email,
    password,
    name: "기존닉네임",
    callbackURL: "/verify-email?verified=1",
  });
}
async function verifyLatest() {
  return auth.handler(new Request(mailURL()));
}
async function login(email: string) {
  return post("/sign-in/email", { email, password });
}

beforeAll(async () => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.BETTER_AUTH_SECRET =
    "isolated-auth-test-secret-at-least-32-characters";
  process.env.BETTER_AUTH_URL = origin;
  process.env.RESEND_API_KEY = "synthetic-resend-key";
  process.env.RESEND_FROM = "test@example.test";
  process.env.GOOGLE_CLIENT_ID = "synthetic-google-id";
  process.env.GOOGLE_CLIENT_SECRET = "synthetic-google-secret";
  vi.stubGlobal("fetch", fetchMock);
  ({ auth } = await import("@/server/auth-config"));
  // Per-address delivery caps remain active; HTTP limiter has independent coverage.
  Object.assign(auth.options.rateLimit!, { enabled: false });
  ({ db } = await import("@/server/db"));
  policy = await import("@/server/auth-policy");
  account = await import("@/server/auth-account");
  const { getMigrations } = await import("better-auth/db/migration");
  await (await getMigrations(auth.options)).runMigrations();
  provider = (await auth.$context).socialProviders.find(
    (p) => p.id === "google",
  )!;
  provider.options!.verifyIdToken = async () => true;
  provider.validateAuthorizationCode = async () => ({
    accessToken: "synthetic-provider-token",
    scopes: ["openid", "email"],
  });
  // Apply the production profile mapping to the synthetic provider identity.
  provider.getUserInfo = async () => ({
    user: {
      name: policy.GOOGLE_PLACEHOLDER,
      ...(await provider.options!.mapProfileToUser?.(identity)),
      email: identity.email,
      emailVerified: identity.email_verified,
    },
    data: identity,
  });
});
beforeEach(() => {
  db.exec(
    "DELETE FROM session; DELETE FROM account; DELETE FROM user; DELETE FROM verification; DELETE FROM auth_profiles; DELETE FROM auth_verification_links; DELETE FROM auth_mail_limits;",
  );
  mails.length = 0;
  fetchMock.mockClear();
  identity = {
    sub: "google-owner",
    email: "google@example.test",
    email_verified: true,
    name: "Private Legal Name",
  };
});
afterAll(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe("native authentication account flow", () => {
  it("returns normal guest status for auth pages while retaining protected account authentication", async () => {
    const { GET: status } = await import("@/app/api/auth/account-status/route");
    const { GET: protectedAccount, POST: accountWrite } =
      await import("@/app/api/account/route");
    const guest = await status(
      new Request(`${origin}/api/auth/account-status`),
    );
    expect(guest.status).toBe(200);
    expect(await guest.json()).toBeNull();
    expect(guest.headers.get("cache-control")).toBe("no-store");
    expect(
      (await protectedAccount(new Request(`${origin}/api/account`))).status,
    ).toBe(401);
    const write = await accountWrite(
      new Request(`${origin}/api/account`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ newPassword: password }),
      }),
    );
    expect(write.status).toBe(400);
    expect(db.prepare("SELECT count(*) AS n FROM account").get()).toEqual({
      n: 0,
    });
    await signup("status@example.test");
    await verifyLatest();
    const cookie = cookieOf(await login("status@example.test"));
    const member = await status(
      new Request(`${origin}/api/auth/account-status`, { headers: { cookie } }),
    );
    expect(member.status).toBe(200);
    expect(await member.json()).toMatchObject({
      email: "status@example.test",
      emailVerified: true,
      nicknameReady: true,
      hasPassword: true,
    });
  });
  it("caps native mail requests regardless of whether the address exists", async () => {
    const context = await auth.$context;
    context.rateLimit.enabled = true;
    try {
      for (let i = 0; i < 3; i++) {
        expect(
          (
            await post("/request-password-reset", {
              email: `absent${i}@example.test`,
            })
          ).status,
        ).toBe(200);
      }
      expect(
        (
          await post("/request-password-reset", {
            email: "absent4@example.test",
          })
        ).status,
      ).toBe(429);
    } finally {
      context.rateLimit.enabled = false;
    }
  });
  async function googleLogin() {
    return post("/sign-in/social", {
      provider: "google",
      idToken: { token: "synthetic-id-token" },
    });
  }
  async function beginLink(cookie: string) {
    const response = await post(
      "/link-social",
      {
        provider: "google",
        callbackURL: "/account",
        errorCallbackURL: "/account?error=auth_failed",
        disableRedirect: true,
      },
      cookie,
    );
    expect(response.status).toBe(200);
    const { url } = await response.json();
    return {
      state: new URL(url).searchParams.get("state")!,
      cookie: `${cookie}; ${cookieOf(response)}`,
    };
  }
  async function finishLink(flow: { state: string; cookie: string }) {
    return auth.handler(
      new Request(
        `${origin}/api/auth/callback/google?code=synthetic-code&state=${encodeURIComponent(flow.state)}`,
        { headers: { cookie: flow.cookie } },
      ),
    );
  }
  it("blocks implicit takeover of an unverified local account; links verified same-email without changing name", async () => {
    await signup("google@example.test");
    expect((await googleLogin()).status).toBe(401);
    expect(
      db
        .prepare("SELECT count(*) AS n FROM account WHERE providerId='google'")
        .get(),
    ).toEqual({ n: 0 });
    await verifyLatest();
    const response = await googleLogin();
    expect(response.status).toBe(200);
    expect(
      await account.accountSnapshot(
        new Headers({ cookie: cookieOf(response) }),
      ),
    ).toMatchObject({
      name: "기존닉네임",
      hasPassword: true,
      emailVerified: true,
    });
  });
  it("keeps Google legal names private, requires nickname, and enables primary email password login", async () => {
    const response = await googleLogin();
    expect(response.status).toBe(200);
    const cookie = cookieOf(response);
    const headers = new Headers({ cookie });
    viewerContext.headers = headers;
    const { getViewer } = await import("@/server/auth");
    expect(await getViewer()).toMatchObject({
      name: "새 회원",
      emailVerified: true,
      nicknameReady: false,
    });
    expect(await account.accountSnapshot(headers)).toMatchObject({
      name: "새 회원",
      nicknameReady: false,
      hasPassword: false,
      emailVerified: true,
    });
    expect(db.prepare("SELECT name FROM user").get()).toEqual({
      name: "새 회원",
    });
    expect((await post("/update-user", { name: "x" }, cookie)).status).toBe(
      400,
    );
    expect(await getViewer()).toMatchObject({
      name: "새 회원",
      nicknameReady: false,
    });
    expect(
      (await post("/update-user", { name: "공개닉네임" }, cookie)).status,
    ).toBe(200);
    expect(await account.accountSnapshot(headers)).toMatchObject({
      name: "공개닉네임",
      nicknameReady: true,
    });
    expect(await getViewer()).toMatchObject({
      name: "공개닉네임",
      emailVerified: true,
      nicknameReady: true,
    });
    await account.setInitialPassword(headers, password);
    expect((await login("google@example.test")).status).toBe(200);
    await expect(
      account.setInitialPassword(headers, password),
    ).rejects.toThrow();
  });
  it("rejects unverified Google identity", async () => {
    identity.email_verified = false;
    expect((await googleLogin()).status).toBeGreaterThanOrEqual(400);
    expect(db.prepare("SELECT count(*) AS n FROM user").get()).toEqual({
      n: 0,
    });
  });
  it("allows explicit different-email linking while preserving primary email and nickname", async () => {
    await signup("local@example.test");
    await verifyLatest();
    const cookie = cookieOf(await login("local@example.test"));
    const flow = await beginLink(cookie);
    const response = await finishLink(flow);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/account");
    expect(
      await account.accountSnapshot(new Headers({ cookie })),
    ).toMatchObject({
      email: "local@example.test",
      name: "기존닉네임",
      googleAccountId: expect.any(String),
    });
  });
  it("refuses another account's Google identity without merging", async () => {
    expect((await googleLogin()).status).toBe(200);
    await signup("local@example.test");
    await verifyLatest();
    const cookie = cookieOf(await login("local@example.test"));
    const response = await finishLink(await beginLink(cookie));
    expect(response.headers.get("location")).toContain(
      "error=account_already_linked_to_different_user",
    );
    expect(
      await account.accountSnapshot(new Headers({ cookie })),
    ).toMatchObject({ email: "local@example.test", googleAccountId: null });
    expect(db.prepare("SELECT count(*) AS n FROM user").get()).toEqual({
      n: 2,
    });
  });
  it("requires the target's fresh authenticated session again on link callback", async () => {
    await signup("local@example.test");
    await verifyLatest();
    const cookie = cookieOf(await login("local@example.test"));
    const flow = await beginLink(cookie);
    db.prepare("UPDATE session SET createdAt=?").run(Date.now() - 700_000);
    const response = await finishLink(flow);
    expect(response.headers.get("location")).toContain(
      "error=session_not_fresh",
    );
    expect(
      await account.accountSnapshot(new Headers({ cookie })),
    ).toMatchObject({ googleAccountId: null });
  });
  it("prevents last-method unlink and password setup with a stale session", async () => {
    const cookie = cookieOf(await googleLogin());
    const headers = new Headers({ cookie });
    const snapshot = (await account.accountSnapshot(headers))!;
    expect(
      (
        await post(
          "/unlink-account",
          { accountId: snapshot.googleAccountId },
          cookie,
        )
      ).status,
    ).toBe(400);
    await account.setInitialPassword(headers, password);
    expect(
      (
        await post(
          "/unlink-account",
          { accountId: snapshot.googleAccountId },
          cookie,
        )
      ).status,
    ).toBe(200);
    expect((await login("google@example.test")).status).toBe(200);
    db.prepare("UPDATE session SET createdAt=?").run(Date.now() - 700_000);
    await expect(account.setInitialPassword(headers, password)).rejects.toThrow(
      "최근 로그인",
    );
    expect(
      policy.remainingLoginMethod(
        [
          { id: "g", providerId: "google" },
          { id: "c", providerId: "credential", password: "hash" },
        ],
        "g",
        false,
      ),
    ).toBe(false);
  });
  it("requires a fixed credential fallback for concurrent Google unlinks", async () => {
    const cookie = cookieOf(await googleLogin());
    const headers = new Headers({ cookie });
    const context = await auth.$context;
    const session = await auth.api.getSession({ headers });
    const second = await context.internalAdapter.createAccount({
      userId: session!.user.id,
      providerId: "google",
      accountId: "synthetic-second-google-identity",
    });
    const first = (await account.accountSnapshot(headers))!.googleAccountId!;
    const blocked = await Promise.all([
      post("/unlink-account", { accountId: first }, cookie),
      post("/unlink-account", { accountId: second.id }, cookie),
    ]);
    expect(blocked.map((response) => response.status)).toEqual([400, 400]);
    expect(
      (await context.internalAdapter.findAccounts(session!.user.id)).filter(
        (a) => a.providerId === "google",
      ),
    ).toHaveLength(2);
    await account.setInitialPassword(headers, password);
    const credential = (
      await context.internalAdapter.findAccounts(session!.user.id)
    ).find((a) => a.providerId === "credential")!;
    expect(
      (await post("/unlink-account", { accountId: credential.id }, cookie))
        .status,
    ).toBe(400);
    const allowed = await Promise.all([
      post("/unlink-account", { accountId: first }, cookie),
      post("/unlink-account", { accountId: second.id }, cookie),
    ]);
    expect(allowed.map((response) => response.status)).toEqual([200, 200]);
    expect((await login("google@example.test")).status).toBe(200);
  });
  it("rejects password setup without verified ownership and unlink with an empty credential", async () => {
    const cookie = cookieOf(await googleLogin());
    const headers = new Headers({ cookie });
    const context = await auth.$context;
    const session = await auth.api.getSession({ headers });
    const googleId = (await account.accountSnapshot(headers))!.googleAccountId!;
    await context.internalAdapter.createAccount({
      userId: session!.user.id,
      providerId: "credential",
      accountId: session!.user.id,
      password: "",
    });
    expect(
      (await post("/unlink-account", { accountId: googleId }, cookie)).status,
    ).toBe(400);
    await context.internalAdapter.updateUser(session!.user.id, {
      emailVerified: false,
    });
    await expect(account.setInitialPassword(headers, password)).rejects.toThrow(
      "이메일 인증",
    );
    expect(await account.accountSnapshot(headers)).toMatchObject({
      emailVerified: false,
      hasPassword: false,
    });
  });
  it("requires ownership before password login, consumes verification once, and keeps nickname", async () => {
    expect((await signup("owner@example.test")).status).toBe(200);
    expect((await login("owner@example.test")).status).toBe(403);
    const link = mailURL();
    const verified = await verifyLatest();
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe("/verify-email?verified=1");
    const replay = await auth.handler(new Request(link));
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toContain("error=invalid_token");
    const response = await login("owner@example.test");
    expect(response.status).toBe(200);
    expect(
      await account.accountSnapshot(
        new Headers({ cookie: cookieOf(response) }),
      ),
    ).toMatchObject({
      emailVerified: true,
      name: "기존닉네임",
      nicknameReady: true,
      hasPassword: true,
    });
  });
  it("expires verification and caps delivery to three per address per hour", async () => {
    await signup("owner@example.test");
    for (let i = 0; i < 4; i++)
      await post("/send-verification-email", { email: "owner@example.test" });
    expect(mails).toHaveLength(3);
    db.prepare("UPDATE auth_verification_links SET expires_at=?").run(
      Date.now() - 1,
    );
    expect((await verifyLatest()).headers.get("location")).toContain(
      "error=invalid_token",
    );
    expect((await login("owner@example.test")).status).toBe(403);
  });
  it("keeps unknown/known recovery and resend responses uniform even on delivery failure", async () => {
    await signup("owner@example.test");
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("private provider detail");
    });
    const known = await post("/send-verification-email", {
      email: "owner@example.test",
    });
    const unknown = await post("/send-verification-email", {
      email: "absent@example.test",
    });
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("private provider detail");
    });
    const resetKnown = await post("/request-password-reset", {
      email: "owner@example.test",
      redirectTo: "/reset-password",
    });
    const resetUnknown = await post("/request-password-reset", {
      email: "absent@example.test",
      redirectTo: "/reset-password",
    });
    expect(resetKnown.status).toBe(resetUnknown.status);
    expect(await resetKnown.json()).toEqual(await resetUnknown.json());
  });
  it("does not resend verification to an already verified account for guests or its signed-in owner", async () => {
    await signup("owner@example.test");
    await verifyLatest();
    const cookie = cookieOf(await login("owner@example.test"));
    fetchMock.mockClear();
    const guest = await post("/send-verification-email", {
      email: "owner@example.test",
    });
    const member = await post(
      "/send-verification-email",
      { email: "owner@example.test" },
      cookie,
    );
    const unknown = await post("/send-verification-email", {
      email: "absent@example.test",
    });
    expect(guest.status).toBe(200);
    expect(member.status).toBe(200);
    expect(await guest.json()).toEqual(await unknown.json());
    expect(await member.json()).toEqual({ status: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("fails uniformly and privately when mail credentials are missing", async () => {
    const key = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const response = await post("/request-password-reset", {
        email: "any@example.test",
      });
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("MAIL_UNAVAILABLE");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.RESEND_API_KEY = key;
    }
  });
  it("resets once, rejects expiration, and revokes existing sessions", async () => {
    await signup("owner@example.test");
    await verifyLatest();
    const cookie = cookieOf(await login("owner@example.test"));
    await post("/request-password-reset", {
      email: "owner@example.test",
      redirectTo: "/reset-password",
    });
    const token = mailURL().pathname.split("/").at(-1)!;
    expect(
      (
        await post("/reset-password", {
          token,
          newPassword: "changed-password-123",
        })
      ).status,
    ).toBe(200);
    expect(
      (await post("/reset-password", { token, newPassword: password })).status,
    ).toBe(400);
    expect(await account.accountSnapshot(new Headers({ cookie }))).toBeNull();
    await post("/request-password-reset", {
      email: "owner@example.test",
      redirectTo: "/reset-password",
    });
    const expired = mailURL().pathname.split("/").at(-1)!;
    db.prepare("UPDATE verification SET expiresAt=? WHERE identifier=?").run(
      Date.now() - 1,
      `reset-password:${expired}`,
    );
    expect(
      (await post("/reset-password", { token: expired, newPassword: password }))
        .status,
    ).toBe(400);
  });
  it("guards the public link endpoint and rejects unsafe callbacks", async () => {
    await signup("owner@example.test");
    await verifyLatest();
    const cookie = cookieOf(await login("owner@example.test"));
    expect(
      (
        await post(
          "/link-social",
          { provider: "google", idToken: { token: "untrusted" } },
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "/link-social",
          { provider: "google", callbackURL: "https://attacker.invalid" },
          cookie,
        )
      ).status,
    ).toBe(403);
    db.prepare("UPDATE session SET createdAt=?").run(Date.now() - 700_000);
    expect(
      (
        await post(
          "/link-social",
          { provider: "google", callbackURL: "/account" },
          cookie,
        )
      ).status,
    ).toBe(403);
  });
  it("validates nickname on the server", async () => {
    expect(
      (
        await post("/sign-up/email", {
          email: "owner@example.test",
          password,
          name: "x",
        })
      ).status,
    ).toBe(400);
    await signup("owner@example.test");
    await verifyLatest();
    const cookie = cookieOf(await login("owner@example.test"));
    expect((await post("/update-user", { name: " " }, cookie)).status).toBe(
      400,
    );
    expect(
      (await post("/update-user", { name: " 새닉네임 " }, cookie)).status,
    ).toBe(200);
    expect(
      await account.accountSnapshot(new Headers({ cookie })),
    ).toMatchObject({ name: "새닉네임", nicknameReady: true });
  });
});
