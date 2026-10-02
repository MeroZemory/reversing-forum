import { getMigrations } from "better-auth/db/migration";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

async function main() {
  const path = process.env.DATABASE_PATH || "data/forum.sqlite";
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true });
  const { auth } = await import("../src/server/auth-config");
  const { db } = await import("../src/server/db");
  await (await getMigrations(auth.options)).runMigrations();
  await (await auth.$context).checkSchema?.();
  db.close();
  console.log("Database initialized.");
}
main().catch(() => {
  console.error(
    "Database initialization failed. Check auth configuration and database access.",
  );
  process.exitCode = 1;
});
