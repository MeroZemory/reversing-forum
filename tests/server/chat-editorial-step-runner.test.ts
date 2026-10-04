import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createEditorialStepRunner } from "../../scripts/chat-editorial-step-runner.mjs";

const roots: string[] = [];
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const write = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value));
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function waitFor(test: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!test()) {
    if (Date.now() > deadline) throw Error("synthetic-child-timeout");
    await new Promise((r) => setTimeout(r, 15));
  }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const calls = join(root, "helper-calls.jsonl");
    if (existsSync(calls)) {
      const pids = readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).pid as number);
      await waitFor(() => pids.every((pid) => !alive(pid)));
    }
    // Delete only the fresh test-owned root; junction removal does not traverse tsx.
    expect(
      root.startsWith(resolve(tmpdir()) + sep + "editorial-step-test-"),
    ).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "editorial-step-test-"));
  roots.push(root);
  const directory = join(root, "pipeline"),
    work = join(root, "work");
  mkdirSync(join(directory, "codex-logs"), { recursive: true });
  mkdirSync(work);
  const checkpoints: unknown[] = [];
  const runner = createEditorialStepRunner({
    root,
    directory,
    work,
    checkpoint: (...args: unknown[]) => checkpoints.push(args),
  });
  return { root, directory, work, checkpoints, ...runner };
}
function nativeFixture() {
  const f = fixture(),
    input = join(f.root, "input.json"),
    output = join(f.root, "output.json");
  write(input, { synthetic: true });
  write(output, { complete: true });
  const args = ["review", input, output, join(f.root, "schema.json")];
  const native = {
    reservationId: "synthetic",
    inputHash: hash(input),
    attemptOutputBytes: readFileSync(output).length,
    outputAccepted: true,
    settled: true,
    finalAccountConfirmed: true,
  };
  const execution = join(f.work, "review.execution.private.json"),
    receipt = join(f.directory, "codex-logs/synthetic.receipt.json");
  write(receipt, native);
  write(execution, {
    script: "chat-codex-run.ts",
    args,
    exitCode: 0,
    stdout: JSON.stringify(native),
    acceptedOutputHash: hash(output),
  });
  return { ...f, input, output, args, native, execution, receipt };
}
const helper = `// SYNTHETIC helper: no corpus or model calls.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
const root=process.cwd(),c=JSON.parse(readFileSync(join(root,'helper-config.json'),'utf8'));
writeFileSync(join(root,'helper-calls.jsonl'),JSON.stringify({pid:process.pid})+'\\n',{flag:'a'});
const dest=process.argv[6];mkdirSync(dest,{recursive:true});
const reviewInput=join(dest,'input.json'),reviewOutput=join(dest,'output.json');
writeFileSync(reviewInput,JSON.stringify(c.content),{flag:'wx'});
if(c.interrupt){writeFileSync(join(root,'ready.json'),JSON.stringify({pid:process.pid,reviewInput}));setTimeout(()=>process.exit(73),1500);}
else if(c.failure)process.exit(9);
else if(c.malformed)console.log('not-json');
else if(c.missingInput)console.log(JSON.stringify({reviewInput:join(dest,'absent.json')}));
else console.log(JSON.stringify({reviewInput,reviewOutput,entries:1}));
`;
function prepFixture() {
  const f = fixture();
  mkdirSync(join(f.root, "scripts"));
  mkdirSync(join(f.root, "node_modules"));
  symlinkSync(
    resolve("node_modules/tsx"),
    join(f.root, "node_modules/tsx"),
    process.platform === "win32" ? "junction" : "dir",
  );
  writeFileSync(join(f.root, "scripts/chat-editorial-batches.ts"), helper);
  const content = { synthetic: true, entries: [{ id: "original" }] };
  write(join(f.root, "helper-config.json"), { content });
  const args = [
    "rereview",
    join(f.root, "draft-in.json"),
    join(f.root, "draft-out.json"),
    "--output-dir",
    join(f.root, "original-preparation"),
  ];
  const execution = join(f.work, "prepare.execution.private.json");
  const run = () => f.run("chat-editorial-batches.ts", args, "prepare");
  return { ...f, args, execution, content, prepare: run };
}

describe("editorial step runner with synthetic receipts and real Node helpers", () => {
  it("reuses a valid cache without a helper and preserves all proof bytes", async () => {
    const f = nativeFixture(),
      paths = [f.input, f.output, f.execution, f.receipt],
      before = paths.map(hash);
    // No helper script exists; executing one would fail this test.
    expect(await f.run("chat-codex-run.ts", f.args, "review", true)).toEqual(
      f.native,
    );
    expect(paths.map(hash)).toEqual(before);
  });
  it.each(["settled", "finalAccountConfirmed", "outputAccepted"])(
    "rejects receipt %s=false without writes",
    async (field) => {
      const f = nativeFixture();
      write(f.receipt, { ...f.native, [field]: false });
      const paths = [f.input, f.output, f.execution, f.receipt],
        before = paths.map(hash);
      await expect(
        f.run("chat-codex-run.ts", f.args, "review", true),
      ).rejects.toThrow("untrusted-native-output");
      expect(paths.map(hash)).toEqual(before);
    },
  );
  it.each(["settled", "finalAccountConfirmed", "outputAccepted"])(
    "rejects native %s=false",
    async (field) => {
      const f = nativeFixture(),
        e = json(f.execution);
      e.stdout = JSON.stringify({ ...f.native, [field]: false });
      write(f.execution, e);
      await expect(
        f.run("chat-codex-run.ts", f.args, "review", true),
      ).rejects.toThrow("untrusted-native-output");
    },
  );
  it("allows historical missing args only when expectedArgs is omitted", () => {
    const f = nativeFixture(),
      e = json(f.execution);
    delete e.args;
    write(f.execution, e);
    const before = hash(f.execution);
    expect(f.checkNative(f.execution, f.input, f.output)).toEqual(f.native);
    expect(() => f.checkNative(f.execution, f.input, f.output, f.args)).toThrow(
      "native-cache-arguments-changed",
    );
    expect(hash(f.execution)).toBe(before);
  });
  it.each(["input", "output", "args", "receipt"])(
    "rejects changed/missing cache %s",
    async (field) => {
      const f = nativeFixture();
      if (field === "input" || field === "output")
        write(f[field], { changed: true });
      else if (field === "args") {
        const e = json(f.execution);
        e.args[3] += "-wrong";
        write(f.execution, e);
      } else rmSync(f.receipt);
      await expect(
        f.run("chat-codex-run.ts", f.args, "review", true),
      ).rejects.toThrow();
    },
  );
  it("rejects repeated drift against the original success without promoting either retry", async () => {
    const f = prepFixture(),
      old = await f.prepare(),
      inputHash = hash(old.reviewInput),
      proofHash = hash(f.execution);
    write(join(f.root, "helper-config.json"), { content: { changed: true } });
    for (let i = 0; i < 2; i++) {
      await expect(f.prepare()).rejects.toThrow(
        "preparation-cache-content-changed",
      );
      expect(hash(f.execution)).toBe(proofHash);
      expect(hash(old.reviewInput)).toBe(inputHash);
    }
    const rejected = readdirSync(f.work).filter((name) =>
      name.includes(".rejected-"),
    );
    expect(rejected).toHaveLength(2);
    expect(rejected.map((name) => json(join(f.work, name)).error)).toEqual([
      "preparation-cache-content-changed",
      "preparation-cache-content-changed",
    ]);
  }, 15000);
  it.each(["failure", "malformed", "missingInput"])(
    "preserves successful preparation after %s, then still rejects drift",
    async (mode) => {
      const f = prepFixture(),
        old = await f.prepare(),
        inputHash = hash(old.reviewInput),
        proofHash = hash(f.execution);
      write(join(f.root, "helper-config.json"), {
        content: f.content,
        [mode]: true,
      });
      await expect(f.prepare()).rejects.toThrow();
      expect(hash(f.execution)).toBe(proofHash);
      if (mode === "failure")
        expect(f.checkpoints).toEqual([
          ["execution-failed", { failedStep: "prepare" }],
        ]);
      write(join(f.root, "helper-config.json"), { content: { changed: true } });
      await expect(f.prepare()).rejects.toThrow(
        "preparation-cache-content-changed",
      );
      expect(hash(f.execution)).toBe(proofHash);
      expect(hash(old.reviewInput)).toBe(inputHash);
      expect(
        readdirSync(f.work).filter((name) => name.includes(".rejected-")),
      ).toHaveLength(2);
    },
    15000,
  );
  it("adopts equivalent regenerated input in a fresh directory", async () => {
    const f = prepFixture(),
      old = await f.prepare(),
      inputHash = hash(old.reviewInput),
      proofHash = hash(f.execution),
      next = await f.prepare();
    expect(next.reviewInput).not.toBe(old.reviewInput);
    expect(
      next.reviewInput.startsWith(join(f.work, "recovered-preparation-")),
    ).toBe(true);
    expect(hash(old.reviewInput)).toBe(inputHash);
    expect(hash(next.reviewInput)).toBe(inputHash);
    const prior = readdirSync(f.work).find((name) => name.includes(".prior-"))!;
    expect(hash(join(f.work, prior))).toBe(proofHash);
  }, 15000);
  it("kills its own driver after immutable input creation and resumes without overwriting it", async () => {
    const f = prepFixture();
    write(join(f.root, "helper-config.json"), {
      content: f.content,
      interrupt: true,
    });
    const driver = join(f.root, "interrupt-driver.mjs");
    const moduleUrl = pathToFileURL(
      resolve("scripts/chat-editorial-step-runner.mjs"),
    ).href;
    writeFileSync(
      driver,
      `import {createEditorialStepRunner} from ${JSON.stringify(moduleUrl)};\nconst r=createEditorialStepRunner(${JSON.stringify({ root: f.root, directory: f.directory, work: f.work })});\nawait r.run('chat-editorial-batches.ts',${JSON.stringify(f.args)},'prepare');`,
    );
    const child = spawn(process.execPath, [driver], {
      windowsHide: true,
      stdio: "ignore",
    });
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((done, fail) => {
      child.once("error", fail);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    try {
      await waitFor(() => existsSync(join(f.root, "ready.json")));
      expect(existsSync(f.execution)).toBe(false);
      expect(child.kill()).toBe(true);
      const ended = await closed;
      expect(ended.signal || ended.code !== 0).toBeTruthy();
      const ready = json(join(f.root, "ready.json"));
      await waitFor(() => !alive(ready.pid));
      const before = hash(ready.reviewInput);
      expect(existsSync(f.execution)).toBe(false);
      write(join(f.root, "helper-config.json"), { content: f.content });
      const resumed = await f.prepare();
      expect(resumed.reviewInput).not.toBe(ready.reviewInput);
      expect(
        resumed.reviewInput.startsWith(join(f.work, "recovered-preparation-")),
      ).toBe(true);
      expect(hash(ready.reviewInput)).toBe(before);
      expect(hash(resumed.reviewInput)).toBe(before);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  }, 15000);
});
