import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { EventEmitter } from "node:events";
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
  startBackupSchedule,
  runBackupProcess,
} from "./production-supervisor.mjs";

const node = "C:\\Program Files\\nodejs\\node.exe";
const script = "C:\\Repo With Spaces\\scripts\\production-supervisor.mjs";
const metadata = { ExecutablePath: node, CommandLine: `"${node}" "${script}"` };

test("백업은 시작 즉시 실행하고 성공 후 다음 UTC 날짜에 예약한다", async () => {
  let calls = 0;
  const timers = [];
  const stop = startBackupSchedule(
    async () => {
      calls++;
    },
    {
      now: () => Date.parse("2026-10-04T12:00:00Z"),
      setTimer: (callback, delay) => {
        timers.push({ callback, delay });
        return 1;
      },
      clearTimer: () => {},
    },
  );
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.equal(timers[0].delay, 12 * 60 * 60 * 1000);
  await timers[0].callback();
  assert.equal(calls, 2);
  stop();
});

test("자정을 넘긴 백업은 현재 날짜를 즉시 실행하고 다음 날짜에 예약한다", async () => {
  let current = Date.parse("2026-10-04T23:59:59Z");
  const dates = [];
  const timers = [];
  const stop = startBackupSchedule(
    async (day) => {
      dates.push(day);
      if (dates.length === 1) current = Date.parse("2026-10-05T00:00:01Z");
    },
    {
      now: () => current,
      setTimer: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimer: () => {},
    },
  );
  await new Promise(setImmediate);
  assert.deepEqual(dates, ["2026-10-04"]);
  assert.equal(timers[0].delay, 0);
  await timers[0].callback();
  assert.deepEqual(dates, ["2026-10-04", "2026-10-05"]);
  assert.equal(timers[1].delay, 24 * 60 * 60 * 1000 - 1000);
  stop();
  await timers[1].callback();
  assert.equal(dates.length, 2);
});

test("실행 중 시계가 되돌아가면 현재 날짜를 즉시 백업한다", async () => {
  let current = Date.parse("2026-10-09T12:00:00Z");
  const dates = [];
  const timers = [];
  const stop = startBackupSchedule(
    async (day) => {
      dates.push(day);
      current = Date.parse("2026-10-01T12:00:00Z");
    },
    {
      now: () => current,
      setTimer: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimer: () => {},
    },
  );
  await new Promise(setImmediate);
  assert.equal(timers[0].delay, 0);
  await timers[0].callback();
  assert.deepEqual(dates, ["2026-10-09", "2026-10-01"]);
  assert.equal(timers[1].delay, 12 * 60 * 60 * 1000);
  stop();
});

test("시간 제한에 도달한 백업은 그 자식만 종료하고 실제 종료까지 기다린다", async () => {
  const child = new EventEmitter();
  let killed = false;
  child.kill = () => {
    killed = true;
    return true;
  };
  const children = new Set();
  let settled = false;
  const pending = runBackupProcess("C:/Isolated", children, {
    day: "2026-10-04",
    timeoutMs: 10,
    spawnChild: (exe, args, options) => {
      assert.equal(exe, process.execPath);
      assert.deepEqual(args.slice(1), ["--day", "2026-10-04"]);
      assert.equal(options.windowsHide, true);
      return child;
    },
  });
  const rejected = assert.rejects(pending, /backup-failed/).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(killed, true);
  assert.equal(settled, false);
  assert.equal(children.has(child), true);
  child.emit("close", null);
  await rejected;
  assert.equal(children.size, 0);
});

test("백업 자식이 정상 종료하면 시간 제한을 해제한다", async () => {
  const child = new EventEmitter();
  let killed = false;
  child.kill = () => {
    killed = true;
    return true;
  };
  const children = new Set();
  const pending = runBackupProcess("C:/Isolated", children, {
    timeoutMs: 20,
    spawnChild: () => child,
  });
  child.emit("close", 0);
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(killed, false);
  assert.equal(children.size, 0);
});

test("백업 실패는 5분 재시도하며 진행 중 중복 예약과 종료 후 예약이 없다", async () => {
  let finish;
  let calls = 0;
  const timers = [];
  let cleared;
  const stop = startBackupSchedule(
    () => {
      calls++;
      if (calls === 1) return Promise.reject(new Error("isolated failure"));
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    {
      setTimer: (callback, delay) => {
        timers.push({ callback, delay });
        return 42;
      },
      clearTimer: (timer) => {
        cleared = timer;
      },
    },
  );
  await new Promise(setImmediate);
  assert.equal(timers[0].delay, 5 * 60 * 1000);
  const pending = timers[0].callback();
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  assert.equal(timers.length, 1);
  stop();
  assert.equal(cleared, 42);
  finish();
  await pending;
  assert.equal(timers.length, 1);
});

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
