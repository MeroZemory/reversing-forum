import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  ModelBudget,
  normalizeUsage,
  usageProxyUsd,
  reservationProxyUsd,
  accountAvailable,
  mcpServerName,
  cliDiagnosticCodes,
  privateCliDiagnostic,
  CodexUsageCollector,
  collectRolloutMetadata,
  type ModelBudgetConfig,
} from "@/server/chat-pipeline/model-budget";
import {
  summarizeReceipts,
  selectRollouts,
} from "../../scripts/chat-model-usage";

const config: ModelBudgetConfig = {
  accountId: "test-account",
  batchStartedAt: new Date(Date.now() - 1000).toISOString(),
  weeklyProxyUsd: { low: 10, central: 16.6581, high: 18.1036 },
  maxPercent: 10,
  creditsPerProxyUsd: 25,
  sources: ["https://example.test/measured"],
  method: "per-invocation-token-proxy",
};
const usage = {
  input_tokens: 100_000,
  cached_input_tokens: 80_000,
  output_tokens: 10_000,
};

describe("Codex final account guard", () => {
  // Run the production final check and settlement without CLI calls or files.
  const source = readFileSync(resolve("scripts/chat-codex-run.ts"), "utf8");
  const start = source.indexOf('process.off("SIGTERM", onSignal);');
  const end = source.indexOf("const receipt =", start);
  if (start < 0 || end < 0) throw new Error("final-account-guard-not-found");
  const body = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const available = { id: config.accountId, quota: { weeklyPercent: 20 } };

  async function check(
    lookup: () => Promise<Parameters<typeof accountAvailable>[0]>,
    options: {
      allowCreditUsage?: boolean;
      exitCode?: number | null;
      rawUsage?: unknown;
      events?: unknown[];
      alreadyStopped?: boolean;
    } = {},
  ) {
    const ledger = new ModelBudget(":memory:", config);
    const reservationId = ledger.reserve(
      "gpt-6-luna",
      "candidate",
      0.1,
      "test",
    )!;
    const delays: number[] = [];
    try {
      const receipt = await runInNewContext(
        `(async () => {
          let stopped = alreadyStopped, stopReason = null, accountStatusFailures = 0;
          const stop = (reason) => { stopped = true; stopReason ??= reason; };
          ${body}
          return { stopped, stopReason, accountStatusFailures, settled };
        })()`,
        {
          process: { off: () => {} },
          onSignal: () => {},
          activeAccount: lookup,
          accountAvailable,
          allocation: { ...config, allowCreditUsage: options.allowCreditUsage },
          setTimeout: (done: () => void, delay: number) => {
            delays.push(delay);
            done();
          },
          collector: (() => {
            const collector = new CodexUsageCollector();
            for (const event of options.events ?? [
              {
                type: "turn.completed",
                usage: "rawUsage" in options ? options.rawUsage : usage,
              },
            ])
              collector.accept(JSON.stringify(event));
            return collector;
          })(),
          result: "exitCode" in options ? options.exitCode : 0,
          alreadyStopped: options.alreadyStopped ?? false,
          cliDiagnosticCodes: () => [],
          writeFileSync: () => {},
          join,
          directory: "synthetic",
          stderr: "",
          prompt: "synthetic",
          privateCliDiagnostic: () => "",
          ledger,
          reservationId,
          model: "gpt-6-luna",
        },
      );
      return { receipt, delays, budget: ledger.summary() };
    } finally {
      ledger.close();
    }
  }

  it.each([1, 2])(
    "settles an exit-zero call after %i lookup failures and a fresh matching account",
    async (failures) => {
      const lookup = vi.fn<() => Promise<typeof available>>();
      for (let i = 0; i < failures; i++)
        lookup.mockRejectedValueOnce(new Error("synthetic OCX lookup failure"));
      lookup.mockResolvedValue(available);
      const { receipt, delays, budget } = await check(lookup);
      expect(lookup).toHaveBeenCalledTimes(failures + 1);
      expect(delays).toEqual(Array(failures).fill(250));
      expect(receipt).toEqual({
        stopped: false,
        stopReason: null,
        accountStatusFailures: failures,
        settled: true,
      });
      expect(budget.unknownRequests).toBe(0);
    },
  );

  it("settles measured project cost after three failed fresh lookups", async () => {
    const lookup = vi
      .fn()
      .mockRejectedValue(new Error("synthetic OCX failure"));
    const { receipt, delays, budget } = await check(lookup);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([250, 250]);
    expect(receipt).toEqual({
      stopped: true,
      stopReason: "account-status-unavailable",
      accountStatusFailures: 3,
      settled: true,
    });
    expect(budget.unknownRequests).toBe(0);
    expect(budget.chargedOrReservedProxyUsd).toBeCloseTo(
      usageProxyUsd("gpt-6-luna", normalizeUsage(usage)!),
    );
  });

  it.each([
    { ...available, id: "different" },
    { ...available, paused: true },
    { ...available, needsReauth: true },
    undefined,
  ])(
    "does not retry a fresh unavailable or changed account: %j",
    async (account) => {
      const lookup = vi.fn().mockResolvedValue(account);
      const { receipt, delays, budget } = await check(lookup, {
        allowCreditUsage: true,
      });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
      expect(receipt.stopReason).toBe("account-unavailable-or-changed");
      expect(receipt.accountStatusFailures).toBe(0);
      expect(receipt.settled).toBe(true);
      expect(budget.unknownRequests).toBe(0);
    },
  );

  it("stops immediately on a mismatch after a lookup error", async () => {
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error("synthetic OCX failure"))
      .mockResolvedValueOnce({ ...available, id: "different" })
      .mockResolvedValue(available);
    const { receipt, delays } = await check(lookup);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([250]);
    expect(receipt.stopReason).toBe("account-unavailable-or-changed");
    expect(receipt.settled).toBe(true);
  });

  it.each([false, true])(
    "preserves subscription quota behavior with credit mode %s",
    async (allowCreditUsage) => {
      const lookup = vi.fn().mockResolvedValue({
        ...available,
        quota: { weeklyPercent: 100 },
      });
      const { receipt, delays } = await check(lookup, { allowCreditUsage });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
      expect(receipt.stopped).toBe(!allowCreditUsage);
      expect(receipt.settled).toBe(true);
    },
  );

  it.each([
    { exitCode: 1 },
    { exitCode: null },
    { rawUsage: null },
    { rawUsage: { input_tokens: 10, output_tokens: 5 } },
    { rawUsage: { ...usage, cached_input_tokens: 100001 } },
    { rawUsage: { ...usage, input_tokens: -1 } },
    { rawUsage: { ...usage, output_tokens: 1.5 } },
    { events: [] },
    { events: [{ type: "turn.completed", usage }, { type: "turn.failed" }] },
    {
      events: [
        { type: "turn.completed", usage },
        { type: "turn.completed", usage: { ...usage, output_tokens: 1 } },
      ],
    },
  ])(
    "does not settle a failed or unknown call after recovery: %j",
    async (options) => {
      const lookup = vi
        .fn()
        .mockRejectedValueOnce(new Error("synthetic OCX failure"))
        .mockResolvedValue(available);
      const { receipt, budget } = await check(lookup, options);
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(receipt.settled).toBe(false);
      expect(budget.unknownRequests).toBe(1);
      expect(budget.chargedOrReservedProxyUsd).toBe(0.1);
    },
  );

  it("settles a completed exit-zero call even when already stopped", async () => {
    const { receipt, budget } = await check(async () => available, {
      alreadyStopped: true,
    });
    expect(receipt.stopped).toBe(true);
    expect(receipt.settled).toBe(true);
    expect(budget.unknownRequests).toBe(0);
    expect(budget.chargedOrReservedProxyUsd).toBeCloseTo(
      usageProxyUsd("gpt-6-luna", normalizeUsage(usage)!),
    );
  });
});

describe("pipeline model proxy budget", () => {
  it("reserves the actual repair model cost before admitting a more expensive call", () => {
    const ledger = new ModelBudget(":memory:", config);
    try {
      expect(
        ledger.reserve("gpt-6-luna", "candidate", 0.85, "prior"),
      ).not.toBeNull();
      const sol = reservationProxyUsd(
        config,
        "candidate",
        "synthetic",
        "gpt-6.1-sol",
      );
      expect(
        ledger.reserve("gpt-6.1-sol", "candidate", sol, "repair"),
      ).toBeNull();
      const luna = reservationProxyUsd(
        config,
        "candidate",
        "synthetic",
        "gpt-6-luna",
      );
      expect(
        ledger.reserve("gpt-6-luna", "candidate", luna, "scan"),
      ).not.toBeNull();
      expect(ledger.summary().chargedOrReservedProxyUsd).toBeLessThan(1);
    } finally {
      ledger.close();
    }
  });
  it("charges uncached, cached and inclusive output separately", () => {
    expect(usageProxyUsd("gpt-6.1-sol", normalizeUsage(usage)!)).toBeCloseTo(
      0.148,
    );
    expect(usageProxyUsd("gpt-6-luna", normalizeUsage(usage)!)).toBeCloseTo(
      0.0078,
    );
    expect(
      usageProxyUsd(
        "gpt-6-luna",
        normalizeUsage({
          input_tokens: 4338149,
          cached_input_tokens: 3797504,
          output_tokens: 30546,
        })!,
      ),
    ).toBeCloseTo(0.10731254);
    expect(normalizeUsage({ ...usage, reasoning_output_tokens: 8000 })).toEqual(
      normalizeUsage(usage),
    );
    expect(normalizeUsage({ input_tokens: 10, output_tokens: 5 })).toBeNull();
    expect(
      normalizeUsage({ ...usage, cached_input_tokens: 100001 }),
    ).toBeNull();
    expect(normalizeUsage({ ...usage, input_tokens: NaN })).toBeNull();
  });
  it("retains failed or unknown calls, settles once and charges actual overruns", () => {
    const ledger = new ModelBudget(":memory:", config);
    try {
      const id = ledger.reserve("gpt-6.1-sol", "review", 0.8, "child")!;
      expect(
        ledger.reserve("gpt-6-luna", "candidate", 0.3, "another"),
      ).toBeNull();
      expect(ledger.settle(id, "gpt-6.1-sol", usage, 1)).toBe(false);
      expect(
        ledger.settle(id, "gpt-6.1-sol", {
          input_tokens: 10,
          output_tokens: 5,
        }),
      ).toBe(false);
      expect(ledger.settle(id, "gpt-6-luna", usage)).toBe(false);
      expect(ledger.summary().chargedOrReservedProxyUsd).toBe(0.8);
      expect(ledger.summary().unknownRequests).toBe(1);
      expect(ledger.settle(id, "gpt-6.1-sol", usage)).toBe(true);
      expect(ledger.settle(id, "gpt-6.1-sol", usage)).toBe(false);
      const overrun = ledger.reserve("gpt-6.1-sol", "review", 0.1, "overrun")!;
      expect(
        ledger.settle(overrun, "gpt-6.1-sol", {
          ...usage,
          output_tokens: 200000,
        }),
      ).toBe(true);
      expect(ledger.summary().chargedOrReservedProxyUsd).toBeGreaterThan(1);
      expect(
        ledger.reserve("gpt-6-luna", "candidate", 0.01, "blocked"),
      ).toBeNull();
      expect(ledger.summary().outputTokens).toBe(210000);
    } finally {
      ledger.close();
    }
  });
  it("keeps the configured 10% low-denominator cap, expires closed, ignores global quota delta", () => {
    const ledger = new ModelBudget(":memory:", config);
    try {
      expect(ledger.summary().limitProxyUsd).toBe(1);
      expect(
        ledger.reserve(
          "gpt-6-luna",
          "candidate",
          0.1,
          "s",
          Date.now() + 8 * 86400000,
        ),
      ).toBeNull();
      expect(
        accountAvailable(
          { id: config.accountId, quota: { weeklyPercent: 30 } },
          config.accountId,
        ),
      ).toBe(true);
      expect(
        accountAvailable(
          { id: config.accountId, quota: { weeklyPercent: 99.9 } },
          config.accountId,
        ),
      ).toBe(true);
      expect(
        accountAvailable(
          { id: config.accountId, quota: { weeklyPercent: 100 } },
          config.accountId,
        ),
      ).toBe(false);
      expect(
        accountAvailable(
          { id: "different", quota: { weeklyPercent: 0 } },
          config.accountId,
        ),
      ).toBe(false);
      expect(accountAvailable({ id: config.accountId }, config.accountId)).toBe(
        false,
      );
      expect(
        accountAvailable(
          { id: config.accountId, quota: { weeklyPercent: 100 } },
          config.accountId,
          true,
        ),
      ).toBe(true);
      expect(
        accountAvailable(
          { id: "different", quota: { weeklyPercent: 100 } },
          config.accountId,
          true,
        ),
      ).toBe(false);
      expect(
        accountAvailable(
          { id: config.accountId, paused: true, quota: { weeklyPercent: 100 } },
          config.accountId,
          true,
        ),
      ).toBe(false);
      expect(
        accountAvailable(
          {
            id: config.accountId,
            needsReauth: true,
            quota: { weeklyPercent: 100 },
          },
          config.accountId,
          true,
        ),
      ).toBe(false);
      expect(
        accountAvailable({ id: config.accountId }, config.accountId, true),
      ).toBe(true);
      expect(
        accountAvailable(
          { id: config.accountId, paused: true },
          config.accountId,
          true,
        ),
      ).toBe(false);
      expect(
        accountAvailable(
          { id: config.accountId, needsReauth: true },
          config.accountId,
          true,
        ),
      ).toBe(false);
      expect(accountAvailable(undefined, config.accountId, true)).toBe(false);
    } finally {
      ledger.close();
    }
    for (const override of [
      { maxPercent: 30.01 },
      { maxPercent: NaN },
      { maxPercent: Infinity },
      { maxPercent: -Infinity },
      { maxPercent: 0 },
      { accountId: "" },
      { creditsPerProxyUsd: 1 },
      { allowCreditUsage: "true" },
      { weeklyProxyUsd: { low: 20, central: 10, high: 30 } },
    ])
      expect(
        () =>
          new ModelBudget(":memory:", {
            ...config,
            ...override,
          } as unknown as ModelBudgetConfig),
      ).toThrow("invalid-model-budget");
    const minimal = {
      ...config,
      reservation: {
        safetyFactor: 1,
        extraInputTokens: 0,
        promptBytesPerToken: 1,
      },
    };
    expect(reservationProxyUsd(minimal, "draft", "abc")).toBeCloseTo(0.0120003);
    expect(
      reservationProxyUsd(
        {
          ...minimal,
          reservation: {
            ...minimal.reservation,
            outputTokens: { draft: 48000 },
          },
        },
        "draft",
        "abc",
      ),
    ).toBeCloseTo(0.0240003);
  });
  it("explicitly permits 20% then 30% in the same window without clearing charged or unknown usage", () => {
    const directory = mkdtempSync(join(tmpdir(), "model-budget-test-"));
    const path = join(directory, "budget.sqlite");
    const original = new ModelBudget(path, config);
    let unknownId: string;
    try {
      expect(original.seedUsage("prior", "gpt-6.1-sol", "review", usage)).toBe(
        true,
      );
      unknownId = original.reserve("gpt-6-luna", "candidate", 0.75, "unknown")!;
      expect(unknownId).not.toBeNull();
      expect(
        original.reserve("gpt-6-luna", "candidate", 1.1, "blocked"),
      ).toBeNull();
    } finally {
      original.close();
    }
    const expanded = new ModelBudget(path, { ...config, maxPercent: 20 });
    const otherAccount = new ModelBudget(path, {
      ...config,
      maxPercent: 20,
      accountId: "different",
    });
    try {
      const before = expanded.summary();
      expect(before.limitProxyUsd).toBe(2);
      expect(before.window.start).toBe(Date.parse(config.batchStartedAt!));
      expect(before.window.end).toBe(before.window.start + 7 * 86_400_000);
      expect(before.requests).toBe(2);
      expect(before.unknownRequests).toBe(1);
      expect(before.chargedOrReservedProxyUsd).toBeCloseTo(0.898);
      expect(otherAccount.settle(unknownId, "gpt-6-luna", usage)).toBe(false);
      expect(otherAccount.summary().requests).toBe(0);
      expect(expanded.settle(unknownId, "gpt-6-luna", null)).toBe(false);
      expect(
        expanded.reserve("gpt-6-luna", "candidate", 1.1, "additional"),
      ).not.toBeNull();
      expect(expanded.summary().chargedOrReservedProxyUsd).toBeCloseTo(1.998);
      expect(expanded.summary().estimatedPercent.high).toBeCloseTo(19.98);
      expect(expanded.summary().unknownRequests).toBe(2);
      // The central/high denominators cannot admit a request over the low cap.
      expect(
        expanded.reserve("gpt-6-luna", "candidate", 0.01, "over-cap"),
      ).toBeNull();
      expect(
        expanded.reserve(
          "gpt-6-luna",
          "candidate",
          0.001,
          "expired",
          before.window.end,
        ),
      ).toBeNull();
      expect(
        expanded.reserve(
          "gpt-6-luna",
          "candidate",
          0.001,
          "early",
          before.window.start - 1,
        ),
      ).toBeNull();
      expect(
        accountAvailable(
          { id: "different", quota: { weeklyPercent: 0 } },
          expanded.config.accountId,
          true,
        ),
      ).toBe(false);
      expect(expanded.summary().requests).toBe(3);
      const expanded30 = new ModelBudget(path, { ...config, maxPercent: 30 });
      try {
        expect(expanded30.summary()).toMatchObject({
          limitProxyUsd: 3,
          requests: 3,
          unknownRequests: 2,
        });
        expect(expanded30.summary().chargedOrReservedProxyUsd).toBeCloseTo(
          1.998,
        );
        expect(expanded30.summary().window).toEqual(before.window);
        expect(
          expanded30.reserve("gpt-6-luna", "candidate", 1, "additional-30"),
        ).not.toBeNull();
        expect(
          expanded30.reserve("gpt-6-luna", "candidate", 0.01, "over-30"),
        ).toBeNull();
      } finally {
        expanded30.close();
      }
    } finally {
      otherAccount.close();
      expanded.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("seeds historical thread usage exactly once even when above cap", () => {
    const ledger = new ModelBudget(":memory:", config);
    try {
      expect(
        ledger.seedUsage("explicit-thread", "gpt-6-luna", "candidate", usage),
      ).toBe(true);
      expect(
        ledger.seedUsage("explicit-thread", "gpt-6-luna", "candidate", usage),
      ).toBe(false);
      expect(ledger.summary().requests).toBe(1);
      expect(ledger.summary().inputTokens).toBe(100000);
    } finally {
      ledger.close();
    }
  });
  it("prevents concurrent processes reserving beyond the same SQLite cap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "model-budget-test-"));
    const path = join(directory, "budget.sqlite");
    const ledger = new ModelBudget(path, config);
    const moduleUrl = pathToFileURL(
      resolve("src/server/chat-pipeline/model-budget.ts"),
    ).href;
    const code = `import { ModelBudget } from ${JSON.stringify(moduleUrl)};
      const ledger = new ModelBudget(${JSON.stringify(path)}, ${JSON.stringify(config)});
      console.log(JSON.stringify(ledger.reserve('gpt-6-luna','candidate',0.7,'parallel'))); ledger.close();`;
    const run = () =>
      new Promise<string>((done, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", code],
          { windowsHide: true },
        );
        let output = "",
          error = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (error += chunk));
        child.on("error", reject);
        child.on("close", (exit) =>
          exit === 0 ? done(output.trim()) : reject(new Error(error)),
        );
      });
    try {
      const results = await Promise.all([run(), run()]);
      expect(
        results.filter((result) => JSON.parse(result) !== null),
      ).toHaveLength(1);
      expect(ledger.summary().chargedOrReservedProxyUsd).toBe(0.7);
    } finally {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("JSON usage telemetry", () => {
  it("reports allowlisted error codes and strips prompt and secrets from private diagnostics", () => {
    const prompt = "private prompt line with error";
    const stderr =
      prompt +
      "\nError: invalid_json_schema\nError: api_key=sk-secret\nError: Bearer secret-token";
    expect(cliDiagnosticCodes(stderr)).toContain("invalid_json_schema");
    const diagnostic = privateCliDiagnostic(stderr, prompt);
    expect(diagnostic).not.toContain(prompt);
    expect(diagnostic).not.toContain("sk-secret");
    expect(diagnostic).not.toContain("secret-token");
    expect(cliDiagnosticCodes("unexpected argument --bad")).toEqual([
      "argument_error",
    ]);
  });
  it("reads only MCP section names, including root, quoted and dotted TOML keys", () => {
    expect(mcpServerName("[mcp_servers]")).toBeNull();
    expect(mcpServerName("[ mcp_servers . playwright ] # comment with ]")).toBe(
      "playwright",
    );
    expect(mcpServerName('["mcp_servers"."server.with.dots".env]')).toBe(
      "server.with.dots",
    );
    expect(mcpServerName("[mcp_servers.'server with spaces'.headers]")).toBe(
      "server with spaces",
    );
    expect(mcpServerName('[mcp_servers."name\\\"with-quote"]')).toBe(
      'name"with-quote',
    );
    expect(mcpServerName('[mcp_servers."\\u006eode_repl"]')).toBe("node_repl");
    expect(mcpServerName('key = "private value"')).toBeNull();
    expect(mcpServerName("[unrelated.section]")).toBeNull();
    expect(() => mcpServerName("[mcp_servers.invalid key]")).toThrow(
      "unsupported-mcp-config-shape",
    );
  });
  it("collects only final CLI usage and deduplicates repeated completions", () => {
    const collector = new CodexUsageCollector();
    collector.accept(
      JSON.stringify({ type: "thread.started", thread_id: "child" }),
    );
    collector.accept(
      JSON.stringify({
        type: "item.completed",
        item: { text: "ignored private content" },
        usage: { input_tokens: 999999 },
      }),
    );
    const completed = JSON.stringify({
      type: "turn.completed",
      usage: { ...usage, reasoning_output_tokens: 8000 },
    });
    collector.accept(completed);
    collector.accept(completed);
    expect(collector.threadId).toBe("child");
    expect(collector.finalUsage()).toEqual(normalizeUsage(usage));
    collector.accept(
      JSON.stringify({
        type: "turn.completed",
        usage: { ...usage, input_tokens: 200000 },
      }),
    );
    expect(collector.finalUsage()).toBeNull();
  });
  it("fails closed for malformed, failed and missing-cache JSON", () => {
    for (const line of [
      "not JSON",
      JSON.stringify({ type: "turn.failed" }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    ]) {
      const c = new CodexUsageCollector();
      c.accept(JSON.stringify({ type: "turn.completed", usage }));
      c.accept(line);
      expect(c.rawUsage()).toBeNull();
    }
  });
  it("counts cumulative rollout deltas once, attributes model switches and ignores conversation records", () => {
    const event = (u: unknown) =>
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: u, last_token_usage: usage },
        },
      });
    const lines = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "child",
          cwd: "same-repo",
          source: { subagent: { thread_spawn: { parent_thread_id: "main" } } },
        },
      }),
      JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-6-luna" },
      }),
      JSON.stringify({ type: "response_item", payload: { text: "ignored" } }),
      event(usage),
      event(usage),
      JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-6.1-sol" },
      }),
      event({
        input_tokens: 150000,
        cached_input_tokens: 120000,
        output_tokens: 15000,
        reasoning_output_tokens: 12000,
      }),
    ];
    const record = collectRolloutMetadata(lines)!;
    expect(record.totals["gpt-6-luna"]).toEqual(normalizeUsage(usage));
    expect(record.totals["gpt-6.1-sol"]).toEqual({
      inputTokens: 50000,
      cachedInputTokens: 40000,
      outputTokens: 5000,
    });
    expect(record.unknownSnapshots).toBe(0);
    expect(
      selectRollouts(
        [
          record,
          record,
          { ...record, threadId: "unrelated", parentThreadId: undefined },
        ],
        new Set(["main"]),
        true,
      ),
    ).toEqual([record]);
    expect(selectRollouts([record], new Set(["main"]), false)).toEqual([]);
    expect(collectRolloutMetadata(lines.slice(1))).toBeNull();
  });
  it("summarizes receipt sessions once and retains unknown reservations", () => {
    const receipt = {
      reservationId: "one",
      sessionId: "child",
      parentThreadId: "main",
      model: "gpt-6-luna" as const,
      usage: normalizeUsage(usage),
      settled: true,
      reservedProxyUsd: 0.1,
    };
    const result = summarizeReceipts(
      [
        receipt,
        receipt,
        { ...receipt, reservationId: "two", usage: null, settled: false },
        {
          ...receipt,
          reservationId: "other",
          sessionId: "unrelated",
          parentThreadId: "elsewhere",
        },
      ],
      new Set(["main"]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].requests).toBe(2);
    expect(result[0].inputTokens).toBe(100000);
    expect(result[0].unknownRequests).toBe(1);
    expect(result[0].chargedOrReservedProxyUsd).toBeCloseTo(0.1078);
  });
});
