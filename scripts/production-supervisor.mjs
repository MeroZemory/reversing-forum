import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { pathToFileURL } from "node:url";

const powershell = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const encode = (script) => Buffer.from(script, "utf16le").toString("base64");
const psLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const normalized = (value) => value.replaceAll("/", "\\").toLowerCase();

export function matchesSupervisorProcess(metadata, executable, script) {
  if (!metadata?.ExecutablePath || !metadata.CommandLine) return null;
  if (normalized(metadata.ExecutablePath) !== normalized(executable))
    return false;
  const args = metadata.CommandLine.trim().match(/"[^"]*"|[^\s"]+/g);
  if (!args || args.length < 2) return false;
  const unquote = (arg) => arg.replace(/^"|"$/g, "");
  return normalized(unquote(args[1])) === normalized(script);
}

export function inspectPid(pid, executable, script, query) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff)
    return "invalid";
  try {
    if (!query) return queryProcess(pid, executable, script);
    const metadata = query(pid);
    if (!metadata) return "absent";
    const matches = matchesSupervisorProcess(metadata, executable, script);
    return matches === null ? "unknown" : matches ? "owned" : "foreign";
  } catch {
    return "unknown";
  }
}

function queryProcess(pid, executable, script) {
  const result = execFileSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encode(
        `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'
if ($null -eq $p) { 'absent' }
elseif (!$p.ExecutablePath -or !$p.CommandLine) { 'unknown' }
elseif ($p.ExecutablePath.Replace('/', '\\') -ine ${psLiteral(normalized(executable))}) { 'foreign' }
else {
  $args = [regex]::Matches($p.CommandLine.Trim(), '"[^"]*"|[^\\s"]+')
  if ($args.Count -ge 2 -and $args[1].Value.Trim('"').Replace('/', '\\') -ieq ${psLiteral(normalized(script))}) { 'owned' } else { 'foreign' }
}`,
      ),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  return ["absent", "unknown", "foreign", "owned"].includes(result)
    ? result
    : "unknown";
}

// The helper owns an OS mutex until stdin closes. No stale lock file survives a crash.
export async function acquireStartupMutex(repo) {
  if (process.platform !== "win32")
    throw new Error("windows-supervisor-required");
  const name =
    "Global\\reversing-forum-" +
    createHash("sha256")
      .update(normalized(resolve(repo)))
      .digest("hex");
  const helper = spawn(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encode(`
$ErrorActionPreference = 'Stop'
$mutex = [System.Threading.Mutex]::new($false, ${psLiteral(name)})
$held = $false
try {
  try { $held = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held = $true }
  if (!$held) { [Console]::Out.WriteLine('busy'); exit 0 }
  [Console]::Out.WriteLine('acquired')
  [Console]::Out.Flush()
  [Console]::In.ReadToEnd() | Out-Null
} finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
`),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  helper.stdin.on("error", () => {});
  return await new Promise((resolveMutex, reject) => {
    let output = "";
    const abandon = () => {
      helper.stdin.destroy();
      if (helper.exitCode === null && !helper.killed) helper.kill();
    };
    const timer = setTimeout(() => {
      abandon();
      reject(new Error("startup-mutex-timeout"));
    }, 15000);
    helper.once("error", () => {
      clearTimeout(timer);
      abandon();
      reject(new Error("startup-mutex-unavailable"));
    });
    helper.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("startup-mutex-unavailable"));
    });
    helper.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes("\n")) return;
      clearTimeout(timer);
      if (output.trim() === "acquired") resolveMutex(helper);
      else {
        helper.stdin.end();
        resolveMutex(null);
      }
    });
  });
}

export async function main() {
  // Run with a hidden detached Node process. Credentials stay in ignored local files.
  const root = resolve(import.meta.dirname, "..");
  const directory = join(root, "data/deployment");
  mkdirSync(directory, { recursive: true });
  const pidPath = join(directory, "supervisor.pid");
  const mutex = await acquireStartupMutex(root);
  if (!mutex) {
    console.error("supervisor-already-running");
    return;
  }
  const children = new Set();
  let stopping = false;
  let ownsPid = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill();
    try {
      if (
        ownsPid &&
        existsSync(pidPath) &&
        readFileSync(pidPath, "utf8").trim() === String(process.pid)
      )
        unlinkSync(pidPath);
    } finally {
      mutex.stdin.end();
    }
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("exit", stop);
  mutex.once("exit", () => {
    if (!stopping) {
      stop();
      process.exitCode = 1;
    }
  });
  try {
    if (existsSync(pidPath)) {
      const text = readFileSync(pidPath, "utf8").trim();
      const old = /^\d+$/.test(text) ? Number(text) : NaN;
      const state = inspectPid(
        old,
        process.execPath,
        join(root, "scripts/production-supervisor.mjs"),
      );
      if (state === "owned") {
        console.error("supervisor-already-running");
        stop();
        return;
      }
      if (state === "unknown") throw new Error("supervisor-owner-unverifiable");
    }
    writeFileSync(pidPath, String(process.pid));
    ownsPid = true;
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
    if (
      !Number.isInteger(originPort) ||
      originPort < 1024 ||
      originPort > 65535
    )
      throw new Error("invalid-origin-port");
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
  } catch (error) {
    stop();
    throw error;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch(() => {
    console.error("supervisor-start-failed");
    process.exitCode = 1;
  });
}
