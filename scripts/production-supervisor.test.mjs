import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  inspectPid,
  matchesSupervisorProcess,
  acquireStartupMutex,
} from "./production-supervisor.mjs";

const node = "C:\\Program Files\\nodejs\\node.exe";
const script = "C:\\Repo With Spaces\\scripts\\production-supervisor.mjs";
const metadata = { ExecutablePath: node, CommandLine: `"${node}" "${script}"` };

test("ownership requires the executable and exact absolute script argument, including spaces", () => {
  assert.equal(matchesSupervisorProcess(metadata, node, script), true);
  assert.equal(
    matchesSupervisorProcess(
      {
        ...metadata,
        CommandLine: `"${node}" "${script.replaceAll("\\", "/")}"`,
      },
      node,
      script,
    ),
    true,
  );
  assert.equal(
    matchesSupervisorProcess(
      { ...metadata, ExecutablePath: "C:\\other.exe" },
      node,
      script,
    ),
    false,
  );
  assert.equal(
    matchesSupervisorProcess(
      { ...metadata, CommandLine: `"${node}" "${script}.other"` },
      node,
      script,
    ),
    false,
  );
  assert.equal(
    matchesSupervisorProcess(
      { ...metadata, CommandLine: `"${node}" --eval "${script}"` },
      node,
      script,
    ),
    false,
  );
  assert.equal(
    matchesSupervisorProcess(
      {
        ...metadata,
        CommandLine: `"${node}" "C:\\other-repo\\scripts\\production-supervisor.mjs"`,
      },
      node,
      script,
    ),
    false,
  );
});

test("PID reuse is foreign; missing or inaccessible metadata is unknown", () => {
  assert.equal(
    inspectPid(123, node, script, () => metadata),
    "owned",
  );
  assert.equal(
    inspectPid(123, node, script, () => ({
      ...metadata,
      ExecutablePath: "C:\\other.exe",
    })),
    "foreign",
  );
  assert.equal(
    inspectPid(123, node, script, () => null),
    "absent",
  );
  assert.equal(
    inspectPid(123, node, script, () => ({
      ExecutablePath: null,
      CommandLine: null,
    })),
    "unknown",
  );
  assert.equal(
    inspectPid(123, node, script, () => {
      throw new Error("access denied");
    }),
    "unknown",
  );
});

test("invalid PIDs never query or signal a process", () => {
  for (const pid of [NaN, 0, -1, 1.5, Infinity, 0x100000000]) {
    assert.equal(
      inspectPid(pid, node, script, () => {
        assert.fail("must not query");
      }),
      "invalid",
    );
  }
});

test(
  "isolated mutex rejects simultaneous startup and releases on stdin close",
  { skip: process.platform !== "win32" },
  async () => {
    const repo = `C:\\Isolated Test ${randomUUID()}`;
    const first = await acquireStartupMutex(repo);
    assert.ok(first);
    try {
      assert.equal(await acquireStartupMutex(repo), null);
    } finally {
      const exited = once(first, "exit");
      first.stdin.end();
      await exited;
    }
    const next = await acquireStartupMutex(repo);
    assert.ok(next);
    const exited = once(next, "exit");
    next.stdin.end();
    await exited;
  },
);

test(
  "mutex timeout terminates only its own isolated helper",
  { skip: process.platform !== "win32" },
  async () => {
    const repo = mkdtempSync(join(tmpdir(), "supervisor timeout test "));
    try {
      const original = readFileSync(
        new URL("./production-supervisor.mjs", import.meta.url),
        "utf8",
      );
      const altered =
        "export let testHelper;\n" +
        original
          .replace(
            'helper.stdin.on("error", () => {});',
            'testHelper = helper; helper.stdin.on("error", () => {});',
          )
          .replace(
            "$mutex = [System.Threading.Mutex]::new",
            "[System.Threading.Thread]::Sleep(30000)\n$mutex = [System.Threading.Mutex]::new",
          )
          .replace("}, 15000);", "}, 1000);");
      assert.ok(altered.includes("}, 1000);"));
      const modulePath = join(repo, "timeout-fixture.mjs");
      writeFileSync(modulePath, altered);
      const module = await import(pathToFileURL(modulePath).href);
      const pending = module.acquireStartupMutex(repo);
      const helper = module.testHelper;
      const exited = once(helper, "exit");
      await assert.rejects(pending, /startup-mutex-timeout/);
      await exited;
      assert.equal(helper.killed, true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
);

test(
  "reentry preserves an owned live PID; reused foreign PID is never terminated",
  { skip: process.platform !== "win32" },
  async () => {
    const repo = mkdtempSync(join(tmpdir(), "supervisor space test "));
    const fixtureScript = join(repo, "scripts/production-supervisor.mjs");
    const pidFile = join(repo, "data/deployment/supervisor.pid");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    mkdirSync(join(repo, "data/deployment"), { recursive: true });
    writeFileSync(
      fixtureScript,
      'process.stdout.write("ready\\n"); process.stdin.resume();',
    );
    const fixture = spawn(process.execPath, [fixtureScript], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    await once(fixture.stdout, "data");
    try {
      writeFileSync(pidFile, String(fixture.pid));
      copyFileSync(
        new URL("./production-supervisor.mjs", import.meta.url),
        fixtureScript,
      );
      const reentry = spawn(process.execPath, [fixtureScript], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.deepEqual(await once(reentry, "exit"), [0, null]);
      assert.equal(readFileSync(pidFile, "utf8"), String(fixture.pid));
      assert.equal(fixture.exitCode, null);
      // Force a metadata lookup failure only in the isolated copy; preserve the live PID file.
      const isolatedSource = readFileSync(fixtureScript, "utf8");
      const injectedSource = isolatedSource.replace(
        "function queryProcess(pid, executable, script) {",
        'function queryProcess(pid, executable, script) { return "unknown";',
      );
      assert.notEqual(injectedSource, isolatedSource);
      writeFileSync(fixtureScript, injectedSource);
      const unverifiable = spawn(process.execPath, [fixtureScript], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.deepEqual(await once(unverifiable, "exit"), [1, null]);
      assert.equal(readFileSync(pidFile, "utf8"), String(fixture.pid));
      assert.equal(fixture.exitCode, null);
      const secondRepo = mkdtempSync(
        join(tmpdir(), "supervisor foreign test "),
      );
      try {
        mkdirSync(join(secondRepo, "scripts"));
        mkdirSync(join(secondRepo, "data/deployment"), { recursive: true });
        const secondScript = join(
          secondRepo,
          "scripts/production-supervisor.mjs",
        );
        const secondPid = join(secondRepo, "data/deployment/supervisor.pid");
        copyFileSync(
          new URL("./production-supervisor.mjs", import.meta.url),
          secondScript,
        );
        writeFileSync(secondPid, String(fixture.pid));
        const candidate = spawn(process.execPath, [secondScript], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        // Missing fixture config fails safely, without reading production secrets.
        assert.deepEqual(await once(candidate, "exit"), [1, null]);
        assert.equal(existsSync(secondPid), false);
        assert.equal(fixture.exitCode, null);
      } finally {
        rmSync(secondRepo, { recursive: true, force: true });
      }
    } finally {
      const exited = once(fixture, "exit");
      fixture.stdin.end();
      await exited;
      rmSync(repo, { recursive: true, force: true });
    }
  },
);
