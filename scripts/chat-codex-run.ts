import { spawn, execFile } from "node:child_process";
import {
  readFileSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  createReadStream,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import Database from "better-sqlite3";
import {
  candidateRelativeContext,
  codexPrompt,
  stopCodexProcess,
} from "../src/server/chat-pipeline/relative-context";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  ModelBudget,
  CodexUsageCollector,
  accountAvailable,
  reservationProxyUsd,
  mcpServerName,
  cliDiagnosticCodes,
  privateCliDiagnostic,
  PROXY_BASIS,
  type ModelBudgetConfig,
  type BatchMode,
} from "../src/server/chat-pipeline/model-budget";

// Pipeline-only overrides; never changes user/project model settings.
const mode = process.argv[2] as BatchMode;
const inputPath = resolve(process.argv[3] || "");
const outputPath = resolve(process.argv[4] || "");
const schemaPath = resolve(process.argv[5] || "");
if (!["candidate", "draft", "review"].includes(mode) || !process.argv[5])
  throw new Error("codex-batch-arguments-required");
const directory = resolve("data/chat-pipeline");
if (
  ![inputPath, outputPath, schemaPath].every(
    (p) => p.startsWith(directory + "\\") || p.startsWith(directory + "/"),
  )
)
  throw new Error("private-workspace-path-required");
mkdirSync(join(directory, "codex-logs"), { recursive: true });
const npmDirectory = resolve(process.env.APPDATA || "", "npm/node_modules");
const codexEntry = join(npmDirectory, "@openai/codex/bin/codex.js");
const ocxEntry = join(npmDirectory, "@bitkyc08/opencodex/bin/ocx.mjs");
if (!existsSync(codexEntry) || !existsSync(ocxEntry))
  throw new Error("cli-not-found");
const allocation = JSON.parse(
  readFileSync(
    resolve(
      process.env.CHAT_MODEL_BUDGET_CONFIG ||
        join(directory, "model-budget.json"),
    ),
    "utf8",
  ),
) as ModelBudgetConfig;
const ledger = new ModelBudget(
  resolve(
    process.env.CHAT_MODEL_BUDGET_PATH ||
      join(directory, "model-budget.sqlite"),
  ),
  allocation,
);
const execute = promisify(execFile);
async function activeAccount() {
  const { stdout } = await execute(
    process.execPath,
    [ocxEntry, "account", "refresh", "openai", "--json"],
    {
      windowsHide: true,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1_000_000,
    },
  );
  return JSON.parse(stdout).accounts.find((a: { active: boolean }) => a.active);
}
// Inspect only TOML section names. Never extract/print config values or credentials.
async function mcpOverrides(): Promise<string[]> {
  const paths = new Set<string>();
  paths.add(
    join(
      process.env.CODEX_HOME || join(process.env.USERPROFILE || "", ".codex"),
      "config.toml",
    ),
  );
  for (let current = directory; ; current = dirname(current)) {
    paths.add(join(current, ".codex", "config.toml"));
    if (dirname(current) === current) break;
  }
  const names = new Set<string>();
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const reader = createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    });
    for await (const line of reader) {
      const name = mcpServerName(line);
      if (name !== null) names.add(name);
      else if (/^\s*mcp_servers\s*=/.test(line))
        throw new Error("unsupported-mcp-config-shape");
    }
  }
  // Installed Codex splits override paths on literal dots; TOML quote syntax in
  // a path is treated as part of the name, creating an invalid transport entry.
  // Quoted TOML section names are decoded above; ordinary names go in unquoted.
  // Do not guess an override for exotic names that this CLI cannot represent.
  if ([...names].some((name) => !/^[A-Za-z0-9_-]+$/.test(name)))
    throw new Error("unsupported-mcp-override-name");
  return [...names].flatMap((name) => [
    "-c",
    `mcp_servers.${name}.enabled=false`,
  ]);
}
const model = mode === "review" ? "gpt-6.1-sol" : "gpt-6-luna";
const effort =
  mode === "candidate" ? "high" : mode === "draft" ? "max" : "xhigh";
const source = readFileSync(inputPath, "utf8");
if (Buffer.byteLength(source) > 500_000)
  throw new Error("codex-input-overflow");
let context: ReturnType<typeof candidateRelativeContext> | undefined;
if (mode === "candidate") {
  const db = new Database(join(directory, "jobs.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    context = candidateRelativeContext(db, JSON.parse(source));
  } finally {
    db.close();
  }
}
const {
  prompt,
  inputHash: hash,
  actualPromptHash,
} = codexPrompt(source, context);
try {
  const overrides = await mcpOverrides();
  const active = await activeAccount();
  if (!accountAvailable(active, allocation.accountId)) {
    console.log(
      JSON.stringify({
        started: false,
        reason: "account-unavailable-or-changed",
      }),
    );
    process.exitCode = 2;
  } else {
    const reservedProxyUsd = reservationProxyUsd(allocation, mode, prompt);
    const parentThreadId =
      process.env.MAIN_THREAD_ID ||
      allocation.parentThreadId ||
      "chat-editorial-batch";
    const reservationId = ledger.reserve(
      model,
      mode,
      reservedProxyUsd,
      parentThreadId,
    );
    if (!reservationId) {
      console.log(
        JSON.stringify({
          started: false,
          reason: "batch-proxy-budget-boundary",
          budget: ledger.summary(),
        }),
      );
      process.exitCode = 2;
    } else {
      // Confirmed against the installed CLI's features list. Disable tool sources,
      // including plugin/app injection, independently of the prompt.
      const disabled = [
        "shell_tool",
        "unified_exec",
        "multi_agent",
        "multi_agent_v2",
        "apps",
        "plugins",
        "browser_use",
        "computer_use",
        "image_generation",
        "code_mode_host",
        "hooks",
        "fast_mode",
      ];
      const child = spawn(
        process.execPath,
        [
          codexEntry,
          "exec",
          "--json",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          ...disabled.flatMap((feature) => ["--disable", feature]),
          ...overrides,
          "-c",
          'web_search="disabled"',
          "--model",
          model,
          "-c",
          `model_reasoning_effort="${effort}"`,
          "-c",
          'approval_policy="never"',
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          "--color",
          "never",
          "-",
        ],
        { cwd: directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      const collector = new CodexUsageCollector();
      const lines = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      lines.on("line", (line) => collector.accept(line));
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 64_000)
          stderr += chunk.toString().slice(0, 64_000 - stderr.length);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
      let stopped = false,
        checking = false;
      let exited = false;
      let pendingStop: Promise<void> | undefined;
      let stopFailed = false;
      const stop = () => {
        stopped = true;
        if (exited || pendingStop) return;
        pendingStop = stopCodexProcess(child).catch(() => {
          if (!exited) stopFailed = true;
        });
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      let pendingCheck: Promise<void> | undefined;
      const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        pendingCheck = activeAccount()
          .then((account) => {
            if (!accountAvailable(account, allocation.accountId)) {
              stop();
            }
          })
          .catch(() => {
            stop();
          })
          .finally(() => {
            checking = false;
          });
      }, 15_000);
      const result = await new Promise<number | null>((done) => {
        child.on("close", (code) => {
          exited = true;
          done(code);
        });
        child.on("error", () => done(-1));
      });
      clearInterval(timer);
      await pendingCheck;
      await pendingStop;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      try {
        if (!accountAvailable(await activeAccount(), allocation.accountId))
          stopped = true;
      } catch {
        stopped = true;
      }
      const usage = collector.finalUsage();
      const diagnosticCodes = result !== 0 ? cliDiagnosticCodes(stderr) : [];
      if (result !== 0)
        writeFileSync(
          join(directory, "codex-logs", `${reservationId}.stderr.private.log`),
          privateCliDiagnostic(stderr, prompt),
        );
      const settled =
        !stopped &&
        ledger.settle(reservationId, model, collector.rawUsage(), result);
      const receipt = {
        reservationId,
        sessionId: collector.threadId,
        parentThreadId,
        model,
        effort,
        inputHash: hash,
        actualPromptHash,
        usage,
        reservedProxyUsd,
        settled,
        stopped,
        stopFailed,
        exitCode: result,
        diagnosticCodes,
        basis: PROXY_BASIS,
        completedAt: new Date().toISOString(),
      };
      writeFileSync(
        join(directory, "codex-logs", `${reservationId}.receipt.json`),
        JSON.stringify(receipt, null, 2),
      );
      console.log(
        JSON.stringify({
          ...receipt,
          outputExists: existsSync(outputPath),
          budget: ledger.summary(),
        }),
      );
      if (result !== 0 || stopped || !settled) process.exitCode = 1;
    }
  }
} finally {
  ledger.close();
}
