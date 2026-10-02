import { readFileSync } from "node:fs";
import { testMailboxPath } from "./auth-test-mailbox";

const allowed = new Set([
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "RESEND_KEY_FILE",
  "RESEND_API_KEY_FILE",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
]);
// Optional private dotenv-style file. Never log its contents or override an
// explicitly configured environment value; unrelated variables are ignored.
export function loadAuthEnvironment(path = process.env.AUTH_CONFIG_FILE) {
  if (testMailboxPath()) return;
  if (!path) return;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    throw new Error("AUTH_CONFIG_FILE could not be read.");
  }
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(
      line,
    );
    if (!match || !allowed.has(match[1]) || process.env[match[1]] !== undefined)
      continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    process.env[match[1]] = value;
  }
}
loadAuthEnvironment();
