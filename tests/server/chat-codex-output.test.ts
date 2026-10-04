import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  acceptCodexAttemptOutput,
  createCodexAttemptOutput,
} from "@/server/chat-pipeline/staged-codex-output";
import { accountAvailable } from "@/server/chat-pipeline/model-budget";

import { finishCodexReceipt } from "../../scripts/chat-codex-receipt";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const payload = '{"complete":true,"entries":[]}';
const passing = {
  exitCode: 0,
  stopped: false,
  settled: true,
  finalAccountConfirmed: true,
};
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "codex-output-synthetic-"));
  roots.push(directory);
  const logs = join(directory, "codex-logs");
  mkdirSync(logs);
  const attemptOutputPath = createCodexAttemptOutput(logs);
  const outputPath = join(directory, "reusable.output.json");
  writeFileSync(attemptOutputPath, payload);
  return { directory, logs, attemptOutputPath, outputPath };
}

describe("private Codex transport promotion", () => {
  it("isolates attempts and promotes complete bytes without deleting evidence", () => {
    const f = fixture();
    const retry = createCodexAttemptOutput(f.logs);
    expect(retry).not.toBe(f.attemptOutputPath);
    expect(existsSync(f.outputPath)).toBe(false);
    expect(readFileSync(retry, "utf8")).toBe("");
    const result = acceptCodexAttemptOutput(
      f.attemptOutputPath,
      f.outputPath,
      passing,
    );
    expect(result).toEqual({
      outputAccepted: true,
      outputFailure: null,
      attemptOutputExists: true,
      attemptOutputBytes: Buffer.byteLength(payload),
    });
    expect(readFileSync(f.outputPath, "utf8")).toBe(payload);
    expect(readFileSync(f.attemptOutputPath, "utf8")).toBe(payload);
  });

  it.each([
    { exitCode: 1 },
    { exitCode: null },
    { stopped: true },
    { settled: false },
    { finalAccountConfirmed: false },
  ])("keeps rejected transport private for gate %j", (gate) => {
    const f = fixture();
    const result = acceptCodexAttemptOutput(f.attemptOutputPath, f.outputPath, {
      ...passing,
      ...gate,
    });
    expect(result.outputAccepted).toBe(false);
    expect(existsSync(f.outputPath)).toBe(false);
    expect(readFileSync(f.attemptOutputPath, "utf8")).toBe(payload);
  });

  it.each(["missing", "empty", "directory"])(
    "rejects %s transport despite all account/usage gates passing",
    (kind) => {
      const f = fixture();
      rmSync(f.attemptOutputPath);
      if (kind === "empty") writeFileSync(f.attemptOutputPath, "");
      if (kind === "directory") mkdirSync(f.attemptOutputPath);
      const result = acceptCodexAttemptOutput(
        f.attemptOutputPath,
        f.outputPath,
        passing,
      );
      expect(result.outputFailure).toBe("output-transport-missing-or-empty");
      expect(result.attemptOutputBytes).toBe(0);
      expect(existsSync(f.outputPath)).toBe(false);
    },
  );

  it("preserves a canonical output created after the attempt started", () => {
    const f = fixture();
    writeFileSync(f.outputPath, "previously accepted bytes", { flag: "wx" });
    const result = acceptCodexAttemptOutput(
      f.attemptOutputPath,
      f.outputPath,
      passing,
    );
    expect(result.outputFailure).toBe("output-already-exists");
    expect(readFileSync(f.outputPath, "utf8")).toBe(
      "previously accepted bytes",
    );
    expect(readFileSync(f.attemptOutputPath, "utf8")).toBe(payload);
  });

  it("fails closed if the canonical destination is unavailable", () => {
    const f = fixture();
    const output = join(f.directory, "missing-directory", "output.json");
    expect(
      acceptCodexAttemptOutput(f.attemptOutputPath, output, passing)
        .outputFailure,
    ).toBe("output-promotion-failed");
    expect(existsSync(output)).toBe(false);
    expect(readFileSync(f.attemptOutputPath, "utf8")).toBe(payload);
  });
});

describe("CLI final lookup, settlement, output and receipt lifecycle", () => {
  // Execute the production finalization with real synthetic transport/receipt
  // files. Only account lookup, ledger and timers are fakes: no model, account
  // changes, or database writes are involved.
  const source = readFileSync(resolve("scripts/chat-codex-run.ts"), "utf8");
  const start = source.indexOf('process.off("SIGTERM", onSignal);');
  const last = "if (!output.outputAccepted) process.exitCode = 1;";
  const end = source.indexOf(last, start);
  if (start < 0 || end < 0) throw new Error("cli-finalization-not-found");
  const body = ts.transpileModule(source.slice(start, end + last.length), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const account = { id: "synthetic-account", quota: { weeklyPercent: 20 } };

  async function finalize(
    options: {
      lookup?: () => Promise<unknown>;
      settled?: boolean;
      stopped?: boolean;
      exitCode?: number;
      existing?: boolean;
      empty?: boolean;
    } = {},
  ) {
    const f = fixture();
    if (options.existing)
      writeFileSync(f.outputPath, "existing accepted bytes");
    if (options.empty) writeFileSync(f.attemptOutputPath, "");
    const processState = { off: () => {}, exitCode: 0 };
    const lookup = vi.fn(options.lookup ?? (async () => account));
    const settle = vi.fn(() => {
      // Settlement must precede canonical output creation.
      expect(existsSync(f.outputPath)).toBe(options.existing ?? false);
      return options.settled ?? true;
    });
    const delays: number[] = [];
    const messages: string[] = [];
    await runInNewContext(
      `(async () => {
        let stopped = initiallyStopped, stopReason = null, accountStatusFailures = 0;
        const stop = (reason) => { stopped = true; stopReason ??= reason; };
        ${body}
      })()`,
      {
        ...f,
        receiptPath: join(f.logs, "synthetic-reservation.receipt.json"),
        finishCodexReceipt,
        Buffer,
        process: processState,
        onSignal: () => {},
        initiallyStopped: options.stopped ?? false,
        activeAccount: lookup,
        accountAvailable,
        allocation: { accountId: account.id },
        setTimeout: (done: () => void, delay: number) => {
          delays.push(delay);
          done();
        },
        ledger: { settle, summary: () => ({ synthetic: true }) },
        collector: { finalUsage: () => null, rawUsage: () => ({}) },
        result: options.exitCode ?? 0,
        acceptCodexAttemptOutput,
        existsSync,
        writeFileSync,
        join,
        console: { log: (message: string) => messages.push(message) },
        reservationId: "synthetic-reservation",
        parentThreadId: "synthetic-parent",
        model: "gpt-6-luna",
        effort: "high",
        hash: "synthetic-input-hash",
        actualPromptHash: "synthetic-prompt-hash",
        actualSchemaHash: "synthetic-schema-hash",
        actualSchemaText: "{}",
        catalog: { hash: "synthetic-catalog", inputBytes: 2 },
        reservedProxyUsd: 0.1,
        timedOut: false,
        stopFailed: false,
        PROXY_BASIS: "synthetic",
        stderr: "",
        prompt: "synthetic",
        cliDiagnosticCodes: () => [],
        privateCliDiagnostic: () => "synthetic",
      },
    );
    const receipt = JSON.parse(
      readFileSync(join(f.logs, "synthetic-reservation.receipt.json"), "utf8"),
    );
    const reported = JSON.parse(messages[0]);
    expect(reported).toMatchObject(receipt);
    expect(reported.outputExists).toBe(existsSync(f.outputPath));
    expect(readFileSync(f.attemptOutputPath, "utf8")).toBe(
      options.empty ? "" : payload,
    );
    return { ...f, receipt, reported, processState, lookup, settle, delays };
  }

  it("promotes only after a transient lookup recovers and usage settles", async () => {
    let calls = 0;
    const f = await finalize({
      lookup: async () => {
        if (++calls === 1) throw new Error("synthetic lookup failure");
        return account;
      },
    });
    expect(f.lookup).toHaveBeenCalledTimes(2);
    expect(f.delays).toEqual([250]);
    expect(f.settle).toHaveBeenCalledOnce();
    expect(f.receipt).toMatchObject({
      stopped: false,
      settled: true,
      finalAccountConfirmed: true,
      outputAccepted: true,
      accountStatusFailures: 1,
    });
    expect(f.processState.exitCode).toBe(0);
    expect(readFileSync(f.outputPath, "utf8")).toBe(payload);
  });

  it.each([false, true])(
    "exit 0 with exhausted final lookups preserves canonical state (existing=%s)",
    async (existing) => {
      const f = await finalize({
        existing,
        lookup: async () => {
          throw new Error("synthetic lookup failure");
        },
      });
      expect(f.lookup).toHaveBeenCalledTimes(3);
      expect(f.delays).toEqual([250, 250]);
      expect(f.settle).toHaveBeenCalledOnce();
      expect(f.receipt).toMatchObject({
        exitCode: 0,
        stopped: true,
        settled: true,
        finalAccountConfirmed: false,
        stopReason: "account-status-unavailable",
        outputAccepted: false,
        attemptOutputBytes: Buffer.byteLength(payload),
      });
      expect(f.processState.exitCode).toBe(1);
      if (existing)
        expect(readFileSync(f.outputPath, "utf8")).toBe(
          "existing accepted bytes",
        );
      else expect(existsSync(f.outputPath)).toBe(false);
    },
  );

  it("settles project cost without retrying a changed final identity or accepting output", async () => {
    const f = await finalize({
      lookup: async () => ({ ...account, id: "other" }),
    });
    expect(f.lookup).toHaveBeenCalledOnce();
    expect(f.settle).toHaveBeenCalledOnce();
    expect(f.receipt).toMatchObject({
      settled: true,
      finalAccountConfirmed: false,
      outputAccepted: false,
    });
    expect(f.receipt.stopReason).toBe("account-unavailable-or-changed");
    expect(f.reported.outputExists).toBe(false);
    expect(f.processState.exitCode).toBe(1);
  });

  it("settles an already stopped exit-zero call while rejecting its output", async () => {
    const f = await finalize({ stopped: true });
    expect(f.settle).toHaveBeenCalledOnce();
    expect(f.receipt).toMatchObject({
      exitCode: 0,
      stopped: true,
      settled: true,
      finalAccountConfirmed: true,
      outputAccepted: false,
    });
    expect(f.reported.outputExists).toBe(false);
    expect(f.processState.exitCode).toBe(1);
  });

  it.each([
    { settled: false },
    { stopped: true },
    { exitCode: 1 },
    { empty: true },
  ])("keeps failed finalizations private: %j", async (options) => {
    const f = await finalize(options);
    expect(f.receipt.outputAccepted).toBe(false);
    expect(f.reported.outputExists).toBe(false);
    expect(f.processState.exitCode).toBe(1);
  });

  it("reports a promotion collision as failure while retaining the old canonical", async () => {
    const f = await finalize({ existing: true });
    expect(f.receipt).toMatchObject({
      settled: true,
      outputAccepted: false,
      outputFailure: "output-already-exists",
    });
    expect(f.reported.outputExists).toBe(true);
    expect(f.processState.exitCode).toBe(1);
    expect(readFileSync(f.outputPath, "utf8")).toBe("existing accepted bytes");
  });
});
