import { spawn, spawnSync } from "node:child_process";

const initialized = spawnSync(
  process.execPath,
  ["--env-file=.env", "--import", "tsx", "scripts/init-db.ts"],
  {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);
if (initialized.status !== 0) process.exit(initialized.status || 1);

const server = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    ...(process.env.FORUM_E2E_BUNDLER === "webpack" ? ["--webpack"] : []),
    "--hostname",
    "127.0.0.1",
    "--port",
    process.env.PORT,
  ],
  {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);
server.on("exit", (code) => process.exit(code || 0));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.kill(signal));
