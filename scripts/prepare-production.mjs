import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Preparation is repeatable. The first deployment copies the live local DB using
// SQLite's backup API, including WAL transactions; later deployments keep production writes.
const directory = resolve("data/deployment");
const production = resolve("data/production");
mkdirSync(directory, { recursive: true });
mkdirSync(production, { recursive: true });
const sourceEnv = readFileSync(".env", "utf8");
const source = Object.fromEntries(
  sourceEnv.split(/\r?\n/).flatMap((line) => {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    return m ? [[m[1], m[2].trim().replace(/^["']|["']$/g, "")]] : [];
  }),
);
const path = join(production, "forum.sqlite");
if (!existsSync(path)) {
  const db = new Database(source.DATABASE_PATH || "data/forum.sqlite", {
    readonly: true,
  });
  try {
    await db.backup(path);
  } finally {
    db.close();
  }
}
const oldPath = join(directory, "runtime-env.json");
const old = existsSync(oldPath)
  ? JSON.parse(readFileSync(oldPath, "utf8"))
  : {};
const values = {
  NODE_ENV: "production",
  NEXT_DIST_DIR: ".next-production",
  BETTER_AUTH_URL: "https://reversing.agentryx-ai.com",
  SITE_URL: "https://reversing.agentryx-ai.com",
  BETTER_AUTH_SECRET:
    old.BETTER_AUTH_SECRET || randomBytes(48).toString("base64url"),
  DATABASE_PATH: path,
  EDITOR_USER_ID: source.EDITOR_USER_ID,
  EDITORIAL_AUTHOR_USER_ID: source.EDITORIAL_AUTHOR_USER_ID,
  TYPESAFE_KEY_FILE: source.TYPESAFE_KEY_FILE,
  ...(source.TYPESAFE_API_KEY
    ? { TYPESAFE_API_KEY: source.TYPESAFE_API_KEY }
    : {}),
  JEV_BUDGET_USD: "10",
  JEV_BUDGET_PATH: resolve(
    source.JEV_BUDGET_PATH || "data/chat-pipeline/jev-budget.sqlite",
  ),
  CHAT_MODEL_BUDGET_CONFIG: resolve("data/chat-pipeline/model-budget.json"),
  CHAT_MODEL_BUDGET_PATH: resolve("data/chat-pipeline/model-budget.sqlite"),
  ...(source.AUTH_CONFIG_FILE
    ? { AUTH_CONFIG_FILE: resolve(source.AUTH_CONFIG_FILE) }
    : {}),
  ...(source.GOOGLE_CLIENT_ID && source.GOOGLE_CLIENT_SECRET
    ? {
        GOOGLE_CLIENT_ID: source.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: source.GOOGLE_CLIENT_SECRET,
      }
    : {}),
};
if (
  !values.EDITOR_USER_ID ||
  !values.EDITORIAL_AUTHOR_USER_ID ||
  (!values.TYPESAFE_KEY_FILE && !values.TYPESAFE_API_KEY)
)
  throw new Error("private-editor-and-screening-config-required");
writeFileSync(oldPath, JSON.stringify(values, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify({
    prepared: true,
    databasePersistent: true,
    url: values.SITE_URL,
    mockScreening: false,
  }),
);
