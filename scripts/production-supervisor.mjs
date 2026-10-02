import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";

// Run with a hidden detached Node process. Credentials stay in ignored local files.
const root = resolve(import.meta.dirname, "..");
const directory = join(root, "data/deployment");
mkdirSync(directory, { recursive: true });
const pidPath = join(directory, "supervisor.pid");
if (existsSync(pidPath)) {
  const old = Number(readFileSync(pidPath, "utf8"));
  try {
    process.kill(old, 0);
    console.error("supervisor-already-running");
    process.exit(1);
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
}
writeFileSync(pidPath, String(process.pid));
const values = JSON.parse(
  readFileSync(join(directory, "runtime-env.json"), "utf8"),
);
if (
  values.NODE_ENV !== "production" ||
  values.BETTER_AUTH_URL !== "https://reversing.agentryx-ai.com" ||
  values.SITE_URL !== values.BETTER_AUTH_URL
)
  throw new Error("production-origin-required");
if (!existsSync(join(root, ".next-production/BUILD_ID")))
  throw new Error("production-build-required");
const { originPort = 3100 } = JSON.parse(
  readFileSync(join(directory, "cloudflare.json"), "utf8"),
);
if (!Number.isInteger(originPort) || originPort < 1024 || originPort > 65535)
  throw new Error("invalid-origin-port");
const children = new Set();
let stopping = false;
function supervise(name, executable, args, extraEnv = {}) {
  if (stopping) return;
  const log = openSync(join(directory, `${name}.private.log`), "a");
  const child = spawn(executable, args, {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, ...values, ...extraEnv },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  children.add(child);
  child.on("error", () => {});
  child.on("close", () => {
    children.delete(child);
    if (!stopping)
      setTimeout(() => supervise(name, executable, args, extraEnv), 5000);
  });
}
supervise("app", process.execPath, [
  join(root, "node_modules/next/dist/bin/next"),
  "start",
  "--hostname",
  "127.0.0.1",
  "--port",
  String(originPort),
]);
// TUNNEL_TOKEN_FILE avoids placing the bearer credential in command-line arguments.
supervise(
  "tunnel",
  join(directory, "cloudflared.exe"),
  ["tunnel", "--no-autoupdate", "run"],
  {
    TUNNEL_TOKEN_FILE: join(directory, "tunnel-token.txt"),
  },
);
function stop() {
  stopping = true;
  for (const child of children) child.kill();
  if (
    existsSync(pidPath) &&
    Number(readFileSync(pidPath, "utf8")) === process.pid
  )
    unlinkSync(pidPath);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("exit", stop);
