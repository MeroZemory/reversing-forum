import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(execute, {
    [Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        execute(
          ...args,
          (error: Error | null, stdout: string, stderr: string) =>
            error ? reject(error) : resolve({ stdout, stderr }),
        );
      }),
  }),
}));
import {
  batchCliEnvironment,
  batchModelCatalog,
  isolatedBatchCatalog,
} from "../../src/server/chat-pipeline/cli-model-catalog";

function fixture(slug = "gpt-6-luna") {
  return {
    slug,
    display_name: "Installed model",
    supported_reasoning_levels: ["medium", "high", "xhigh", "max"].map(
      (effort) => ({
        effort,
        description: `${effort} description`,
      }),
    ),
    context_window: 200000,
    input_modalities: ["text", "image"],
    supports_parallel_tool_calls: true,
    unknown_future_capability: { enabled: true, mode: "preserve", limit: 123 },
    base_instructions: "CODING SCAFFOLD".repeat(10000),
    model_messages: {
      instructions_template: "CODING TEMPLATE".repeat(10000),
      persistent_instructions: "GLOBAL RULES".repeat(10000),
      roles: [
        "CODING ROLE",
        { tool: "TOOL SCAFFOLD", enabled: true, count: 2 },
      ],
      token_budget: {
        enabled: true,
        use_history_notes_extension: true,
        instructions: "HISTORY SCAFFOLD".repeat(10000),
        threshold: 42,
      },
    },
    tool_mode: "code_mode_only",
    experimental_supported_tools: ["shell"],
    apply_patch_tool_type: "freeform",
    include_skills_usage_instructions: true,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    supports_search_tool: true,
    supports_experimental_context: true,
  };
}

it("preserves installed slug, effort descriptions and capability metadata for each route", () => {
  const luna = fixture();
  const sol = fixture("gpt-6.1-sol");
  const raw = { models: [luna, sol] };
  const before = structuredClone(raw);
  for (const [model, effort] of [
    [luna.slug, "high"],
    [luna.slug, "max"],
    [sol.slug, "medium"],
    [sol.slug, "xhigh"],
  ]) {
    const catalog = JSON.parse(batchModelCatalog(raw, model, effort));
    expect(catalog.models).toHaveLength(1);
    const selected = model === luna.slug ? luna : sol;
    for (const key of [
      "slug",
      "display_name",
      "supported_reasoning_levels",
      "context_window",
      "input_modalities",
      "supports_parallel_tool_calls",
      "unknown_future_capability",
    ] as const)
      expect(catalog.models[0][key]).toEqual(selected[key]);
  }
  expect(raw).toEqual(before);
});

it("compacts nested scaffold to a bounded transformer prompt and removes tool sources", () => {
  const text = batchModelCatalog({ models: [fixture()] }, "gpt-6-luna", "max");
  expect(Buffer.byteLength(text)).toBeLessThan(4000);
  expect(text).not.toMatch(
    /CODING|GLOBAL RULES|TOOL SCAFFOLD|HISTORY SCAFFOLD/,
  );
  const model = JSON.parse(text).models[0];
  expect(model.base_instructions).toContain("untrusted quoted data");
  expect(model.base_instructions).toContain("Use no tools");
  expect(model.base_instructions).toContain("output schema");
  expect(model.model_messages.instructions_template).toBe(
    model.base_instructions,
  );
  expect(model.model_messages.roles).toEqual([
    "",
    { tool: "", enabled: true, count: 2 },
  ]);
  expect(model.model_messages.token_budget).toEqual({
    enabled: false,
    use_history_notes_extension: false,
    instructions: "",
    threshold: 42,
  });
  expect(model.tool_mode).toBe("direct");
  expect(model.experimental_supported_tools).toEqual([]);
  expect(model.apply_patch_tool_type).toBeNull();
  for (const key of [
    "include_skills_usage_instructions",
    "include_plugin_usage_instructions",
    "include_apps_usage_instructions",
    "supports_search_tool",
    "supports_experimental_context",
  ])
    expect(model[key]).toBe(false);
});

it("fails closed on malformed, missing or duplicate models and unsupported or missing efforts", () => {
  for (const raw of [null, {}, { models: {} }])
    expect(() => batchModelCatalog(raw, "gpt-6-luna", "high")).toThrow(
      "invalid-cli-model-catalog",
    );
  for (const models of [[], [fixture("other")], [fixture(), fixture()]])
    expect(() => batchModelCatalog({ models }, "gpt-6-luna", "high")).toThrow(
      "missing-or-ambiguous-cli-model",
    );
  for (const levels of [undefined, [], ["high"], [{ effort: "low" }]])
    expect(() =>
      batchModelCatalog(
        { models: [{ ...fixture(), supported_reasoning_levels: levels }] },
        "gpt-6-luna",
        "high",
      ),
    ).toThrow("unsupported-cli-model-effort");
  expect(() =>
    batchModelCatalog({ models: [fixture()] }, "gpt-6-luna", "unsupported"),
  ).toThrow("unsupported-cli-model-effort");
});

it("inherits authentication locations and OS necessities without server or API secrets", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "bin",
    Path: "windows-bin",
    SystemRoot: "windows",
    CODEX_HOME: "auth-home",
    USERPROFILE: "profile",
    HOME: "home",
    APPDATA: "appdata",
    NODE_ENV: "test",
    OPENAI_API_KEY: "secret",
    BETTER_AUTH_SECRET: "secret",
    RESEND_API_KEY: "secret",
    GOOGLE_CLIENT_SECRET: "secret",
    TYPESAFE_API_KEY: "secret",
    CUSTOM_SECRET: "secret",
    CHAT_MODEL_BUDGET_CONFIG: "private-config",
    MAIN_THREAD_ID: "parent",
  };
  expect(batchCliEnvironment(source)).toEqual({
    PATH: "bin",
    Path: "windows-bin",
    SystemRoot: "windows",
    CODEX_HOME: "auth-home",
    USERPROFILE: "profile",
    HOME: "home",
    APPDATA: "appdata",
    NODE_ENV: "test",
  });
});

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
  execute.mockReset();
});

it("reads only bounded hidden bundled metadata and writes a reusable hash-addressed private catalog", async () => {
  directory = mkdtempSync(join(tmpdir(), "chat-cli-catalog-"));
  const env = batchCliEnvironment({
    NODE_ENV: "test",
    CODEX_HOME: "auth-home",
    SERVER_SECRET: "secret",
  });
  execute.mockImplementation((_binary, _args, _options, callback) => {
    callback(null, JSON.stringify({ models: [fixture()] }), "");
  });
  const catalog = await isolatedBatchCatalog(
    "local-codex.js",
    directory,
    env,
    "gpt-6-luna",
    "high",
  );
  expect(execute).toHaveBeenCalledWith(
    process.execPath,
    ["local-codex.js", "debug", "models", "--bundled"],
    {
      cwd: directory,
      env,
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 8000000,
    },
    expect.any(Function),
  );
  const text = readFileSync(catalog.path, "utf8");
  expect(catalog.hash).toBe(createHash("sha256").update(text).digest("hex"));
  expect(catalog.inputBytes).toBe(Buffer.byteLength(text));
  expect(catalog.path).toBe(
    join(directory, "codex-logs", `${catalog.hash}.model-catalog.json`),
  );
  expect(
    await isolatedBatchCatalog(
      "local-codex.js",
      directory,
      env,
      "gpt-6-luna",
      "high",
    ),
  ).toEqual(catalog);
  writeFileSync(catalog.path, "tampered");
  await expect(
    isolatedBatchCatalog(
      "local-codex.js",
      directory,
      env,
      "gpt-6-luna",
      "high",
    ),
  ).rejects.toThrow("cli-model-catalog-hash-mismatch");
});

it("does not continue after local catalog command failure", async () => {
  directory = mkdtempSync(join(tmpdir(), "chat-cli-catalog-"));
  execute.mockImplementation((_binary, _args, _options, callback) =>
    callback(new Error("timeout")),
  );
  await expect(
    isolatedBatchCatalog(
      "local-codex.js",
      directory,
      { NODE_ENV: "test" },
      "gpt-6-luna",
      "high",
    ),
  ).rejects.toThrow("timeout");
});
