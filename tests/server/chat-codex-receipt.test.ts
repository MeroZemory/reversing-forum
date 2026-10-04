import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  linkSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  startCodexReceipt,
  finishCodexReceipt,
} from "../../scripts/chat-codex-receipt";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    linkSync: vi.fn(actual.linkSync),
    renameSync: vi.fn(actual.renameSync),
  };
});
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(writeFileSync).mockReset().mockImplementation(actual.writeFileSync);
  vi.mocked(linkSync).mockReset().mockImplementation(actual.linkSync);
  vi.mocked(renameSync).mockReset().mockImplementation(actual.renameSync);
});
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
describe("durable CLI call start", () => {
  it("writes negative gates and preserves reservation metadata through interruption", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-receipt-"));
    roots.push(root);
    const path = join(root, "call.receipt.json");
    const metadata = {
      reservationId: "00000000-0000-4000-8000-000000000001",
      inputHash: "a".repeat(64),
      model: "synthetic",
      reservedProxyUsd: 1,
      parentThreadId: "synthetic",
      actualPromptHash: "b".repeat(64),
    };
    startCodexReceipt(path, {
      ...metadata,
      outputAccepted: true,
      settled: true,
      finalAccountConfirmed: true,
      exitCode: 0,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      ...metadata,
      outputAccepted: false,
      settled: false,
      finalAccountConfirmed: false,
      exitCode: null,
      stopped: true,
      stopReason: "incomplete",
      usage: null,
    });
    const before = readFileSync(path, "utf8");
    expect(() => startCodexReceipt(path, metadata)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
    const final = {
      ...metadata,
      outputAccepted: true,
      settled: true,
      finalAccountConfirmed: true,
      stopped: false,
      exitCode: 0,
    };
    finishCodexReceipt(path, final);
    expect(readdirSync(root)).toEqual(["call.receipt.json"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(final);
  });
  it("keeps canonical readers on complete negative or final JSON during partial temporary writes", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const root = mkdtempSync(join(tmpdir(), "codex-receipt-"));
    roots.push(root);
    const path = join(
      root,
      "00000000-0000-4000-8000-000000000001.receipt.json",
    );
    let prior: unknown;
    vi.mocked(writeFileSync).mockImplementation((file, data) => {
      expect(typeof file).toBe("number");
      actual.writeFileSync(file, "{");
      expect(
        existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined,
      ).toEqual(prior);
      // The only visible call filename is canonical; temporary is not a call receipt.
      expect(
        readdirSync(root).filter((name) => name.endsWith(".receipt.json")),
      ).toEqual(prior ? [path.split(/[\\/]/).at(-1)] : []);
      actual.ftruncateSync(file as number, 0);
      actual.writeSync(file as number, String(data), 0, "utf8");
    });
    startCodexReceipt(path, {
      reservationId: "synthetic",
      inputHash: "a".repeat(64),
    });
    prior = JSON.parse(readFileSync(path, "utf8"));
    expect(prior).toMatchObject({ outputAccepted: false, settled: false });
    const final = { outputAccepted: true, settled: true, exitCode: 0 };
    finishCodexReceipt(path, final);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(final);
    expect(readdirSync(root)).toHaveLength(1);
  });

  it.each(["write-start", "write-final", "rename-final", "link-start"])(
    "preserves canonical history and cleans temporary on %s error",
    async (kind) => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const root = mkdtempSync(join(tmpdir(), "codex-receipt-"));
      roots.push(root);
      const path = join(root, "call.receipt.json");
      const original = '{"outputAccepted":false,"settled":false}';
      actual.writeFileSync(path, original);
      if (kind.startsWith("write"))
        vi.mocked(writeFileSync).mockImplementation((file) => {
          actual.writeFileSync(file, "{");
          throw new Error("synthetic-write-error");
        });
      if (kind === "rename-final")
        vi.mocked(renameSync).mockImplementation(() => {
          throw new Error("synthetic-rename-error");
        });
      if (kind === "link-start")
        vi.mocked(linkSync).mockImplementation(() => {
          throw new Error("synthetic-link-error");
        });
      expect(() =>
        kind.endsWith("start")
          ? startCodexReceipt(path, {})
          : finishCodexReceipt(path, {}),
      ).toThrow();
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(readdirSync(root)).toEqual(["call.receipt.json"]);
    },
  );

  it("persists before model spawn and preserves the existing final update", () => {
    const source = readFileSync(resolve("scripts/chat-codex-run.ts"), "utf8");
    expect(source.indexOf("startCodexReceipt(receiptPath")).toBeLessThan(
      source.indexOf("const child = spawn("),
    );
    expect(source).toContain(
      "const completedReceipt = { ...receipt, ...output }",
    );
    expect(source).toMatch(
      /finishCodexReceipt\(\s*receiptPath,\s*completedReceipt/,
    );
  });
});
