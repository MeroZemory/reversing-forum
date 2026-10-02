import { createHash } from "node:crypto";
import { db } from "./db";

export const GOOGLE_PLACEHOLDER = "새 회원";
export const FRESH_SECONDS = 600;
db.exec(`
  CREATE TABLE IF NOT EXISTS auth_profiles (user_id TEXT PRIMARY KEY, nickname_ready INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS auth_verification_links (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS auth_mail_limits (digest TEXT PRIMARY KEY, started_at INTEGER NOT NULL, attempts INTEGER NOT NULL);
`);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function validateNickname(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 2 ||
    value.trim().length > 30
  )
    throw new Error("닉네임은 앞뒤 공백을 제외하고 2~30자로 입력해 주세요.");
  return value.trim();
}
export function nicknameReady(userId: string): boolean {
  const row = db
    .prepare("SELECT nickname_ready FROM auth_profiles WHERE user_id = ?")
    .get(userId) as { nickname_ready: number } | undefined;
  return row ? Boolean(row.nickname_ready) : true; // Existing email users keep their public names.
}
export function markNickname(userId: string, ready: boolean) {
  db.prepare(
    "INSERT INTO auth_profiles VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET nickname_ready=excluded.nickname_ready",
  ).run(userId, Number(ready));
}
export function registerVerification(token: string) {
  db.prepare("DELETE FROM auth_verification_links WHERE expires_at <= ?").run(
    Date.now(),
  );
  db.prepare(
    "INSERT OR REPLACE INTO auth_verification_links VALUES (?, ?)",
  ).run(digest(token), Date.now() + 3600_000);
}
export function consumeVerification(token: string): boolean {
  return (
    db
      .prepare(
        "DELETE FROM auth_verification_links WHERE digest = ? AND expires_at > ?",
      )
      .run(digest(token), Date.now()).changes === 1
  );
}
export function allowMail(email: string): boolean {
  return db.transaction(() => {
    const now = Date.now();
    db.prepare("DELETE FROM auth_mail_limits WHERE started_at <= ?").run(
      now - 3600_000,
    );
    const key = digest(email.toLowerCase());
    const row = db
      .prepare("SELECT attempts FROM auth_mail_limits WHERE digest = ?")
      .get(key) as { attempts: number } | undefined;
    if (row && row.attempts >= 3) return false;
    db.prepare(
      "INSERT INTO auth_mail_limits VALUES (?, ?, 1) ON CONFLICT(digest) DO UPDATE SET attempts=attempts+1",
    ).run(key, now);
    return true;
  })();
}
export function isFresh(createdAt: Date | string): boolean {
  const age = Date.now() - new Date(createdAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < FRESH_SECONDS * 1000;
}
export function remainingLoginMethod(
  accounts: { id: string; providerId: string; password?: string | null }[],
  removed: string,
  verified: boolean,
): boolean {
  return accounts.some(
    (a) =>
      a.id !== removed &&
      a.providerId === "credential" &&
      Boolean(a.password) &&
      verified,
  );
}
