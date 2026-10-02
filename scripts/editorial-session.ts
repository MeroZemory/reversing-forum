import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Bootstrap actual Better Auth accounts and a real session; never construct a Viewer.
// Credentials/cookies remain only in ignored local files and are never printed.
const privateDir = resolve("data/chat-pipeline");
mkdirSync(privateDir, { recursive: true });
const accountFile = resolve(privateDir, "editorial-accounts.json");
const origin = new URL(process.env.BETTER_AUTH_URL || "http://127.0.0.1:3000")
  .origin;
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("local-bootstrap-only");
type Account = { name: string; email: string; password: string; id?: string };
const accounts: { operator: Account; editorial: Account } = existsSync(
  accountFile,
)
  ? JSON.parse(readFileSync(accountFile, "utf8"))
  : {
      operator: {
        name: "MeroZemory",
        email: "operator@reversingall.local",
        password: randomBytes(36).toString("base64url"),
      },
      editorial: {
        name: "자료편집",
        email: "editorial@reversingall.local",
        password: randomBytes(36).toString("base64url"),
      },
    };
writeFileSync(accountFile, JSON.stringify(accounts));
async function authenticate(account: Account) {
  const route = account.id ? "sign-in/email" : "sign-up/email";
  const response = await fetch(`${origin}/api/auth/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      name: account.name,
      email: account.email,
      password: account.password,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`account-bootstrap-http-${response.status}`);
  const result = (await response.json()) as { user?: { id?: string } };
  if (!result.user?.id) throw new Error("account-bootstrap-invalid-response");
  account.id = result.user.id;
  writeFileSync(accountFile, JSON.stringify(accounts));
  return response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .join("; ");
}
async function main() {
  const cookie = await authenticate(accounts.operator);
  await authenticate(accounts.editorial);
  const envPath = resolve(".env");
  let env = readFileSync(envPath, "utf8");
  for (const [name, value] of Object.entries({
    EDITOR_USER_ID: accounts.operator.id!,
    EDITORIAL_AUTHOR_USER_ID: accounts.editorial.id!,
    JEV_BUDGET_USD: "10",
    JEV_BUDGET_PATH: "data/chat-pipeline/jev-budget.sqlite",
  })) {
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^${name}=.*$`, "m");
    env = pattern.test(env)
      ? env.replace(pattern, line)
      : `${env.trimEnd()}\n${line}\n`;
  }
  writeFileSync(envPath, env);
  writeFileSync(
    resolve(privateDir, "editorial-session.json"),
    JSON.stringify({ origin, cookie }),
  );
  console.log(
    JSON.stringify({
      authenticated: true,
      authorRole: "editorial",
      configurationSaved: true,
    }),
  );
}
main().catch(() => {
  console.error("자료 계정 준비에 실패했습니다. 비공개 설정을 확인해 주세요.");
  process.exitCode = 1;
});
