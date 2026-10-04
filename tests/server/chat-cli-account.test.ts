import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  createReadStream,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  cliAccountAvailable,
  cliAccountEnvironment,
  cliAccountUsesPinnedHome,
  type CliAccountConfig,
} from "@/server/chat-pipeline/cli-account";
import {
  mcpServerName,
  validateModelBudget,
} from "@/server/chat-pipeline/model-budget";
import { batchCliEnvironment } from "@/server/chat-pipeline/cli-model-catalog";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cli-account-test-")));
  roots.push(home);
  const config: CliAccountConfig = {
    accountId: "same-legacy-ledger-group",
    codexHome: home,
    codexAccountFingerprint: createHash("sha256")
      .update("synthetic-stable-id")
      .digest("hex"),
    allowCreditUsage: true,
    batchStartedAt: new Date().toISOString(),
    weeklyProxyUsd: { low: 10, central: 15, high: 20 },
    maxPercent: 20,
    source: "synthetic-measurement",
    method: "token-proxy",
  };
  const auth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      account_id: "synthetic-stable-id",
      access_token: "synthetic-old",
      refresh_token: "synthetic-old",
      id_token: "synthetic-old",
    },
  };
  const write = (value: unknown) =>
    writeFileSync(join(home, "auth.json"), JSON.stringify(value));
  write(auth);
  const env = cliAccountEnvironment(config, { NODE_ENV: "test" });
  const ocx = join(home, "absent-ocx.mjs");
  return { home, config, auth, write, env, ocx };
}

describe("real CLI account pin", () => {
  it("rejects escaped quoted assignment keys before loading home config", async () => {
    const f = fixture();
    writeFileSync(
      join(f.home, "config.toml"),
      String.raw`"model_instructions_\u0066ile" = "synthetic-instructions.md"` +
        "\n",
    );
    await expect(cliAccountUsesPinnedHome(f.config, f.env)).rejects.toThrow(
      "cli-account-instructions-file-unsupported",
    );
  });

  it("loads transport only for a fresh pin and rejects inherited instruction files", async () => {
    const f = fixture();
    expect(await cliAccountUsesPinnedHome(f.config, f.env)).toBe(true);
    const {
      codexHome: _home,
      codexAccountFingerprint: _fingerprint,
      ...legacy
    } = f.config;
    expect(await cliAccountUsesPinnedHome(legacy, f.env)).toBe(false);
    writeFileSync(
      join(f.home, "config.toml"),
      'model_instructions_file = "private-instructions.md"\n',
    );
    await expect(cliAccountUsesPinnedHome(f.config, f.env)).rejects.toThrow(
      "cli-account-instructions-file-unsupported",
    );
    writeFileSync(
      join(f.home, "config.toml"),
      'model_instructions_file = "" # explicitly empty\n',
    );
    expect(await cliAccountUsesPinnedHome(f.config, f.env)).toBe(true);
    f.write({ ...f.auth, tokens: { account_id: "swapped-account" } });
    await expect(cliAccountUsesPinnedHome(f.config, f.env)).rejects.toThrow(
      "cli-account-pin-invalid",
    );
  });

  it("pins sanitized children, preserves ledger group/cap, and allows token rotation", async () => {
    const f = fixture();
    const source = {
      NODE_ENV: "test" as const,
      PATH: "synthetic-path",
      CODEX_HOME: "wrong-inherited-home",
    };
    expect(cliAccountEnvironment(f.config, source)).toEqual({
      ...source,
      CODEX_HOME: f.home,
    });
    expect(source.CODEX_HOME).toBe("wrong-inherited-home");
    expect(validateModelBudget(f.config).accountId).toBe(
      "same-legacy-ledger-group",
    );
    expect(() =>
      validateModelBudget({ ...f.config, maxPercent: 21 }),
    ).toThrow();
    expect(await cliAccountAvailable(f.config, f.env, f.ocx)).toBe(true);
    f.write({
      ...f.auth,
      tokens: {
        ...f.auth.tokens,
        access_token: "synthetic-new",
        refresh_token: "synthetic-new",
        id_token: "synthetic-new",
      },
    });
    expect(await cliAccountAvailable(f.config, f.env, f.ocx)).toBe(true);
    f.write({
      ...f.auth,
      tokens: { ...f.auth.tokens, account_id: "other-account" },
    });
    expect(await cliAccountAvailable(f.config, f.env, f.ocx)).toBe(false);
  });
  it.each([
    { codexHome: undefined },
    { codexHome: "relative/home" },
    { codexHome: "" },
    { codexAccountFingerprint: undefined },
    { codexAccountFingerprint: "bad" },
    { allowCreditUsage: undefined },
    { allowCreditUsage: false },
    { codexHome: null },
    { codexAccountFingerprint: 123 },
  ])("rejects partial/malformed/unauthorized pin %j", async (change) => {
    const f = fixture();
    const config = { ...f.config, ...change } as CliAccountConfig;
    expect(await cliAccountAvailable(config, f.env, f.ocx)).toBe(false);
    expect(() => cliAccountEnvironment(config, { NODE_ENV: "test" })).toThrow(
      "cli-account-pin-invalid",
    );
  });
  it("rejects missing home/auth, missing or swapped child environment, and aliases", async () => {
    const f = fixture();
    expect(
      await cliAccountAvailable(f.config, { NODE_ENV: "test" }, f.ocx),
    ).toBe(false);
    expect(
      await cliAccountAvailable(
        f.config,
        { NODE_ENV: "test", CODEX_HOME: tmpdir() },
        f.ocx,
      ),
    ).toBe(false);
    const missing = { ...f.config, codexHome: join(f.home, "missing") };
    expect(await cliAccountAvailable(missing, f.env, f.ocx)).toBe(false);
    const physical = join(f.home, "physical");
    mkdirSync(physical);
    const alias = join(f.home, "alias");
    symlinkSync(physical, alias, "junction");
    expect(
      await cliAccountAvailable(
        { ...f.config, codexHome: alias },
        { NODE_ENV: "test", CODEX_HOME: alias },
        f.ocx,
      ),
    ).toBe(false);
    rmSync(join(f.home, "auth.json"));
    expect(await cliAccountAvailable(f.config, f.env, f.ocx)).toBe(false);
    writeFileSync(join(f.home, "auth.json"), "malformed-json");
    expect(await cliAccountAvailable(f.config, f.env, f.ocx)).toBe(false);
  });
  it.each([
    null,
    [],
    {},
    { auth_mode: "apikey", tokens: { account_id: "synthetic-stable-id" } },
    { auth_mode: "chatgpt", tokens: null },
    { auth_mode: "chatgpt", tokens: { account_id: " " } },
    { auth_mode: "chatgpt", tokens: { account_id: 123 } },
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: "synthetic-key",
      tokens: { account_id: "synthetic-stable-id" },
    },
  ])("fails closed for invalid authentication metadata %j", async (auth) => {
    const f = fixture();
    f.write(auth);
    expect(await cliAccountAvailable(f.config, f.env, f.ocx)).toBe(false);
  });
  it("preserves actual legacy helper checks, quota flags, and absent-helper failure", async () => {
    const f = fixture();
    const {
      codexHome: _home,
      codexAccountFingerprint: _fingerprint,
      ...legacy
    } = f.config;
    expect(cliAccountEnvironment(legacy, { NODE_ENV: "test" })).toEqual({
      NODE_ENV: "test",
    });
    expect(await cliAccountAvailable(legacy, { NODE_ENV: "test" }, f.ocx)).toBe(
      false,
    );
    const helper = join(f.home, "synthetic-ocx.mjs");
    const legacyOutput = (active: unknown) =>
      writeFileSync(
        helper,
        `if (process.argv.slice(2).join(' ') !== ${JSON.stringify("account list openai --quota --json")}) process.exit(2); console.log(${JSON.stringify(JSON.stringify({ accounts: [active] }))});`,
      );
    legacy.allowCreditUsage = false;
    legacyOutput({
      active: true,
      id: legacy.accountId,
      quota: { weeklyPercent: 20 },
    });
    expect(
      await cliAccountAvailable(legacy, { NODE_ENV: "test" }, helper),
    ).toBe(true);
    legacyOutput({ active: true, id: "other", quota: { weeklyPercent: 20 } });
    expect(
      await cliAccountAvailable(legacy, { NODE_ENV: "test" }, helper),
    ).toBe(false);
    legacyOutput({
      active: true,
      id: legacy.accountId,
      quota: { weeklyPercent: 100 },
    });
    expect(
      await cliAccountAvailable(legacy, { NODE_ENV: "test" }, helper),
    ).toBe(false);
    // Partial pin must never invoke even an installed legacy helper.
    expect(
      await cliAccountAvailable(
        { ...legacy, codexHome: f.home },
        { NODE_ENV: "test" },
        helper,
      ),
    ).toBe(false);
    writeFileSync(
      helper,
      `console.log(${JSON.stringify(JSON.stringify({ accounts: [{ active: true, id: legacy.accountId }] }))});`,
    );
    expect(
      await cliAccountAvailable(
        { ...legacy, allowCreditUsage: true },
        { NODE_ENV: "test" },
        helper,
      ),
    ).toBe(true);
  });
});

// Evaluate the production launch arrays and MCP header scanners, then execute only
// a synthetic local CLI. No real CLI, provider, network, or production DB is used.
describe("pinned transport isolation at both callsites", () => {
  it.each(["batch", "judge"] as const)(
    "retains selected-home transport and isolates %s calls",
    async (route) => {
      const f = fixture();
      const configText = `model_provider = "cliproxyapi"
developer_instructions = "synthetic inherited instruction"
notify = ["synthetic-notify-command"]
[model_providers.cliproxyapi]
base_url = "http://127.0.0.1:10100/v1"
requires_openai_auth = true
experimental_bearer_token = "synthetic-transport-secret"
[mcp_servers.playwright]
command = "synthetic-command"
[mcp_servers.openaiDeveloperDocs]
url = "http://127.0.0.1/unused"
[mcp_servers.ida-multi-mcp]
command = "synthetic-command"
[mcp_servers.node_repl]
command = "synthetic-command"
[hooks]
synthetic = "synthetic-hook-command"
`;
      writeFileSync(join(f.home, "config.toml"), configText);
      const directory = join(f.home, "runtime");
      mkdirSync(directory);
      mkdirSync(join(f.home, ".codex"));
      writeFileSync(
        join(f.home, ".codex", "config.toml"),
        '[mcp_servers.project]\ncommand="synthetic-command"\n',
      );
      const parentEnv = {
        NODE_ENV: "test" as const,
        PATH: process.env.PATH,
        CODEX_HOME: "wrong-home",
        OPENAI_API_KEY: "synthetic-parent-secret",
        TYPESAFE_API_KEY: "synthetic-parent-secret",
        UNRELATED_SECRET: "synthetic-parent-secret",
      };
      const source = readFileSync(
        resolve(
          route === "batch"
            ? "scripts/chat-codex-run.ts"
            : "src/server/duplicates/llm.ts",
        ),
        "utf8",
      );
      const ast = ts.createSourceFile(
        "caller.ts",
        source,
        ts.ScriptTarget.ES2022,
        true,
      );
      let launch = "",
        disabled = "",
        scanner = "",
        environment = "";
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ["spawn", "run"].includes(node.expression.getText(ast))
        ) {
          const args = node.arguments.find(ts.isArrayLiteralExpression);
          if (args) launch = args.getText(ast);
        }
        if (
          ts.isVariableDeclaration(node) &&
          node.name.getText(ast) === "disabled"
        )
          disabled = node.initializer!.getText(ast);
        if (
          ts.isFunctionDeclaration(node) &&
          node.name?.text === "mcpOverrides"
        )
          scanner = node.getText(ast);
        if (
          ts.isFunctionDeclaration(node) &&
          node.name?.text === "cliEnvironment"
        )
          environment = node.getText(ast);
        ts.forEachChild(node, visit);
      };
      visit(ast);
      expect(launch && disabled && scanner).toBeTruthy();
      const transpile = (code: string) =>
        ts.transpileModule(code, {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText;
      const sanitized =
        route === "batch"
          ? batchCliEnvironment(parentEnv)
          : runInNewContext(transpile(environment) + "cliEnvironment();", {
              process: { env: parentEnv },
            });
      const env = cliAccountEnvironment(f.config, sanitized);
      const pinnedHome = await cliAccountUsesPinnedHome(f.config, env);
      const overrides: string[] = await runInNewContext(
        transpile(scanner) + "mcpOverrides(directory, env);",
        {
          directory,
          env,
          join,
          createReadStream,
          createInterface,
          existsSync,
          mcpServerName,
          // Bound the ancestor scan to this synthetic fixture.
          dirname: (path: string) => (path === f.home ? path : dirname(path)),
        },
      );
      for (const name of [
        "playwright",
        "openaiDeveloperDocs",
        "ida-multi-mcp",
        "node_repl",
        "project",
      ])
        expect(overrides).toContain(`mcp_servers.${name}.enabled=false`);
      const syntheticCli = join(f.home, "synthetic-codex.mjs");
      writeFileSync(
        syntheticCli,
        `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), overrides = args.filter((_, i) => args[i - 1] === '-c');
const text = args.includes('--ignore-user-config') ? '' : readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
const custom = text.includes('model_provider = "cliproxyapi"');
const servers = [...text.matchAll(/\\[mcp_servers\\.([A-Za-z0-9_-]+)\\]/g)].map(m => m[1]).filter(n => !overrides.includes('mcp_servers.' + n + '.enabled=false'));
console.log(JSON.stringify({ provider: custom ? 'cliproxyapi' : 'openai', loopbackTransport: custom && text.includes('http://127.0.0.1:10100/v1'), requiresOpenAIAuth: custom && text.includes('requires_openai_auth = true'), bearerConfigured: custom && text.includes('experimental_bearer_token = '), servers, ignoreRules: args.includes('--ignore-rules'), developerInstructionsCleared: !text || overrides.includes('developer_instructions=""'), notifyDisabled: !text || overrides.includes('notify=[]'), hooksDisabled: args.some((v,i) => v === '--disable' && args[i+1] === 'hooks'), parentSecrets: Object.keys(process.env).filter(k => /^(OPENAI_API_KEY|TYPESAFE_API_KEY|UNRELATED_SECRET)$/.test(k)) }));`,
      );
      const globals = {
        pinnedHome,
        overrides,
        disabled: runInNewContext(disabled),
        codexEntry: syntheticCli,
        codex: syntheticCli,
        catalog: { path: join(f.home, "isolated-catalog.json") },
        model: "gpt-6-luna",
        effort: "high",
        actualSchemaPath: "synthetic-schema",
        schemaPath: "synthetic-schema",
        attemptOutputPath: "synthetic-output",
      };
      const args: string[] = runInNewContext(
        transpile(`(${launch});`),
        globals,
      );
      expect(args).not.toContain("--ignore-user-config");
      expect(args.join(" ")).not.toMatch(
        /synthetic-transport-secret|synthetic-parent-secret|experimental_bearer_token/,
      );
      const result = JSON.parse(
        execFileSync(process.execPath, args, {
          env,
          encoding: "utf8",
          windowsHide: true,
        }),
      );
      expect(result).toEqual({
        provider: "cliproxyapi",
        loopbackTransport: true,
        requiresOpenAIAuth: true,
        bearerConfigured: true,
        servers: [],
        ignoreRules: true,
        developerInstructionsCleared: true,
        notifyDisabled: true,
        hooksDisabled: true,
        parentSecrets: [],
      });
      const legacyArgs: string[] = runInNewContext(transpile(`(${launch});`), {
        ...globals,
        pinnedHome: false,
        overrides: route === "batch" ? [] : overrides,
      });
      expect(legacyArgs).toContain("--ignore-user-config");
      expect(legacyArgs).toContain("--ignore-rules");
      const legacy = JSON.parse(
        execFileSync(process.execPath, legacyArgs, {
          env,
          encoding: "utf8",
          windowsHide: true,
        }),
      );
      expect(legacy.provider).toBe("openai");
      expect(legacy.notifyDisabled).toBe(true);
      expect(legacy.parentSecrets).toEqual([]);
    },
  );
});
