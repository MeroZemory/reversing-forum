import { resolve, relative, isAbsolute } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function testMailboxPath(): string | null {
  const requested = process.env.FORUM_AUTH_TEST_MAILBOX;
  if (!requested || process.env.NODE_ENV === "production") return null;
  const path = resolve(requested);
  const location = relative(resolve(process.cwd(), "data"), path);
  const parts = location.split(/[\\/]/);
  const scopedFile =
    parts.length === 1 &&
    /^e2e-[a-f0-9]+-(pass|hold|error)\.mail\.jsonl$/i.test(parts[0]);
  const scopedDirectory =
    parts.length >= 2 && /^(e2e-[\w-]+|ui-ux(?:-[\w-]+)?)$/.test(parts[0]);
  if (
    isAbsolute(location) ||
    parts.includes("..") ||
    (!scopedFile && !scopedDirectory)
  )
    throw new Error(
      "FORUM_AUTH_TEST_MAILBOX must be inside data/e2e-*/ or data/ui-ux*/, or a data/e2e-<hex>-<phase>.mail.jsonl file.",
    );
  return path;
}
export function captureTestMail(
  email: string,
  url: string,
  reset: boolean,
): boolean {
  const path = testMailboxPath();
  if (!path) return false;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    JSON.stringify({ email, url, reset, createdAt: new Date().toISOString() }) +
      "\n",
    { encoding: "utf8", mode: 0o600 },
  );
  return true;
}
