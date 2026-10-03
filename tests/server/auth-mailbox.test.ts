import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { captureTestMail, testMailboxPath } from "@/server/auth-test-mailbox";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("captures privately without reading auth credentials or calling Resend", async () => {
  mkdirSync("data", { recursive: true });
  const directory = mkdtempSync(resolve("data/e2e-auth-mailbox-"));
  try {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("FORUM_AUTH_TEST_MAILBOX", resolve(directory, "mailbox.jsonl"));
    vi.stubEnv(
      "AUTH_CONFIG_FILE",
      resolve(directory, "missing-private-credentials.env"),
    );
    const fetch = vi.fn(async () => Response.json({ id: "synthetic" }));
    vi.stubGlobal("fetch", fetch);
    const { sendAuthMail, mailConfigured } = await import("@/server/auth-mail");
    expect(mailConfigured()).toBe(true);
    expect(
      await sendAuthMail(
        "synthetic@example.test",
        "http://localhost/verify?token=synthetic",
      ),
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(resolve(directory, "mailbox.jsonl"), "utf8")),
    ).toMatchObject({
      email: "synthetic@example.test",
      url: "http://localhost/verify?token=synthetic",
      reset: false,
    });
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv("NODE_ENV", "production");
    expect(testMailboxPath()).toBeNull();
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("RESEND_FROM", "");
    expect(mailConfigured()).toBe(false);
    expect(
      await sendAuthMail("synthetic@example.test", "http://localhost/verify"),
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv("RESEND_API_KEY", "synthetic-production-key");
    vi.stubEnv("RESEND_FROM", "synthetic@example.test");
    vi.stubEnv("BETTER_AUTH_URL", "https://forum.example.test");
    expect(mailConfigured()).toBe(true);
    expect(
      await sendAuthMail(
        "synthetic@example.test",
        "https://forum.example.test/verify",
      ),
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
it("sends branded HTML and text while refusing links outside the configured production origin", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("FORUM_AUTH_TEST_MAILBOX", "");
  vi.stubEnv("RESEND_API_KEY", "synthetic-production-key");
  vi.stubEnv("RESEND_FROM", "Legacy name <synthetic@example.test>");
  vi.stubEnv("BETTER_AUTH_URL", "https://forum.example.test");
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ id: "synthetic" }),
  );
  vi.stubGlobal("fetch", fetch);
  const { sendAuthMail } = await import("@/server/auth-mail");
  const url =
    "https://forum.example.test/api/auth/verify-email?token=synthetic&callbackURL=%2Faccount";
  expect(await sendAuthMail("synthetic@example.test", url)).toBe(true);
  const payload = JSON.parse(fetch.mock.calls[0][1]!.body as string);
  expect(payload.from).toBe("Reversing All <synthetic@example.test>");
  expect(payload.html).toContain("이메일 인증");
  expect(payload.text).toContain(url);
  for (const invalid of [
    "http://127.0.0.1:3000/api/auth/verify-email?token=synthetic",
    "https://different.example.test/verify",
    "https://forum.example.test.attacker.test/verify",
    "https://user:password@forum.example.test/verify",
    "javascript:alert(1)",
  ])
    expect(await sendAuthMail("synthetic@example.test", invalid)).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  for (const local of [
    "http://localhost:3000",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
  ]) {
    vi.stubEnv("BETTER_AUTH_URL", local);
    expect(
      await sendAuthMail("synthetic@example.test", `${local}/verify`),
    ).toBe(false);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("accepts the parent's scoped E2E filename and UI review directory", () => {
  vi.stubEnv("NODE_ENV", "test");
  for (const path of [
    "data/e2e-a1b2c3-pass.mail.jsonl",
    "data/e2e-a1b2c3-hold.mail.jsonl",
    "data/e2e-a1b2c3-error.mail.jsonl",
    "data/ui-ux/pass-1234.mail.jsonl",
  ]) {
    vi.stubEnv("FORUM_AUTH_TEST_MAILBOX", resolve(path));
    expect(testMailboxPath()).toBe(resolve(path));
  }
});
it("rejects capture destinations outside the explicitly scoped test directory", () => {
  vi.stubEnv("NODE_ENV", "test");
  for (const path of [
    "data/real-mailbox.jsonl",
    "data/e2e-test/../../outside.jsonl",
    "C:/_authentication/mailbox.jsonl",
  ]) {
    vi.stubEnv("FORUM_AUTH_TEST_MAILBOX", path);
    expect(() => testMailboxPath()).toThrow("must be inside");
  }
});
it("loads only allowed auth variables and preserves existing environment values", async () => {
  mkdirSync("data", { recursive: true });
  const directory = mkdtempSync(resolve("data/e2e-auth-env-"));
  try {
    vi.stubEnv("FORUM_AUTH_TEST_MAILBOX", "");
    vi.stubEnv("AUTH_CONFIG_FILE", "");
    vi.stubEnv("GOOGLE_CLIENT_ID", undefined);
    vi.stubEnv("RESEND_FROM", "existing@example.test");
    vi.stubEnv("UNRELATED_TEST_VARIABLE", undefined);
    const path = resolve(directory, "synthetic.env");
    writeFileSync(
      path,
      'GOOGLE_CLIENT_ID="synthetic-client-id"\nRESEND_FROM=replacement@example.test\nUNRELATED_TEST_VARIABLE=ignored\n',
    );
    const { loadAuthEnvironment } = await import("@/server/auth-environment");
    loadAuthEnvironment(path);
    expect(process.env.GOOGLE_CLIENT_ID).toBe("synthetic-client-id");
    expect(process.env.RESEND_FROM).toBe("existing@example.test");
    expect(process.env.UNRELATED_TEST_VARIABLE).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true });
  }
});
