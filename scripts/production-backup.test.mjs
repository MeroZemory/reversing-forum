import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  lstatSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { backupProduction } from "./production-backup.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "production-backup-"));
  mkdirSync(join(root, "data/production"), { recursive: true });
  mkdirSync(join(root, "data/deployment"));
  const directory = join(root, "data/production-backups");
  mkdirSync(directory);
  const source = join(root, "data/production/forum.sqlite");
  const config = join(root, "data/deployment/runtime-env.json");
  writeFileSync(
    config,
    JSON.stringify({ DATABASE_PATH: "data/production/forum.sqlite" }),
  );
  const db = new Database(source);
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.exec(
    "CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES (1, 'isolated fixture');",
  );
  const children = [];
  t.after(async () => {
    for (const { child, finished } of children) {
      if (child.exitCode === null && child.signalCode === null && !child.killed)
        child.kill();
      await finished;
    }
    db.close();
    cleanupOwned(root, "production-backup-");
  });
  return { root, directory, source, config, db, children };
}
function cleanupOwned(root, prefix) {
  assert.equal(dirname(root), realpathSync(tmpdir()));
  assert.ok(root.startsWith(join(realpathSync(tmpdir()), prefix)));
  assert.equal(realpathSync(root), root);
  assert.equal(lstatSync(root).isSymbolicLink(), false);
  rmSync(root, { recursive: true, force: true });
}
const at = (day) =>
  new Date(`2026-10-${String(day).padStart(2, "0")}T12:00:00Z`);
const daily = (f, day) =>
  join(f.directory, `production-${at(day).toISOString().slice(0, 10)}.sqlite`);
const files = (f) =>
  readdirSync(f.directory)
    .filter((name) => /^production-.*\.sqlite$/.test(name))
    .sort();

test("WAL의 미체크포인트 행을 백업하고 원본을 보존하며 격리 복구가 가능하다", async (t) => {
  const f = fixture(t);
  assert.ok(statSync(`${f.source}-wal`).size > 0);
  const before = [readFileSync(f.source), readFileSync(`${f.source}-wal`)];
  const rows = f.db.prepare("SELECT * FROM sample").all();
  const result = await backupProduction({ root: f.root, now: at(1) });
  assert.equal(result.status, "created");
  const restore = join(f.root, "restored.sqlite");
  copyFileSync(daily(f, 1), restore);
  const db = new Database(restore);
  try {
    assert.deepEqual(db.prepare("SELECT * FROM sample").all(), rows);
    assert.equal(db.pragma("quick_check", { simple: true }), "ok");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    db.exec("INSERT INTO sample VALUES (2, 'restore only')");
  } finally {
    db.close();
  }
  assert.deepEqual(f.db.prepare("SELECT * FROM sample").all(), rows);
  assert.deepEqual(readFileSync(f.source), before[0]);
  assert.deepEqual(readFileSync(`${f.source}-wal`), before[1]);
});

test("같은 날 재호출과 동시 호출은 하나의 확정 파일만 만든다", async (t) => {
  const f = fixture(t);
  const first = backupProduction({ root: f.root, now: at(1) });
  assert.equal(backupProduction({ root: f.root, now: at(1) }), first);
  await first;
  const before = readFileSync(daily(f, 1));
  f.db.exec("INSERT INTO sample VALUES (2, 'later')");
  assert.equal(
    (await backupProduction({ root: f.root, now: at(1) })).status,
    "existing",
  );
  assert.deepEqual(readFileSync(daily(f, 1)), before);
  assert.equal(files(f).length, 1);
});

test("새 백업의 외래 키 검증 실패는 기존 백업을 삭제하지 않고 다음 재시도를 허용한다", async (t) => {
  const f = fixture(t);
  for (let day = 1; day <= 7; day++)
    await backupProduction({ root: f.root, now: at(day) });
  const before = files(f).map((name) => readFileSync(join(f.directory, name)));
  f.db.pragma("foreign_keys = OFF");
  f.db.exec(
    "CREATE TABLE child (parent INTEGER REFERENCES sample(id)); INSERT INTO child VALUES (999);",
  );
  await assert.rejects(
    backupProduction({ root: f.root, now: at(8) }),
    /invalid-backup/,
  );
  assert.equal(existsSync(daily(f, 8)), false);
  assert.deepEqual(
    files(f).map((name) => readFileSync(join(f.directory, name))),
    before,
  );
  assert.equal(
    readdirSync(f.directory).some((name) => name.startsWith(".partial-")),
    false,
  );
  f.db.exec("DELETE FROM child");
  await backupProduction({ root: f.root, now: at(8) });
  assert.equal(files(f).length, 7);
});

test("빈 파일·손상 파일·중단된 부분 파일은 성공으로 재사용하거나 덮어쓰지 않는다", async (t) => {
  const f = fixture(t);
  const partial = join(f.directory, ".partial-abandoned.sqlite");
  writeFileSync(partial, "incomplete");
  writeFileSync(daily(f, 1), "");
  await assert.rejects(
    backupProduction({ root: f.root, now: at(1) }),
    /invalid-backup/,
  );
  assert.equal(statSync(daily(f, 1)).size, 0);
  writeFileSync(daily(f, 2), "invalid");
  await assert.rejects(
    backupProduction({ root: f.root, now: at(2) }),
    /invalid-backup/,
  );
  assert.equal(readFileSync(daily(f, 2), "utf8"), "invalid");
  await backupProduction({ root: f.root, now: at(3) });
  assert.equal(readFileSync(partial, "utf8"), "incomplete");
  const completePartial = join(f.directory, ".partial-complete.sqlite");
  copyFileSync(daily(f, 3), completePartial);
  f.db.exec("INSERT INTO sample VALUES (2, 'new day')");
  await backupProduction({ root: f.root, now: at(4) });
  const restored = new Database(daily(f, 4), { readonly: true });
  try {
    assert.equal(
      restored.prepare("SELECT count(*) AS n FROM sample").get().n,
      2,
    );
  } finally {
    restored.close();
  }
  assert.ok(existsSync(completePartial));
});

test("확정 직후 보관 정리가 중단됐어도 같은 날 재호출로 최근 7개만 남긴다", async (t) => {
  const f = fixture(t);
  await backupProduction({ root: f.root, now: at(1) });
  for (let day = 2; day <= 8; day++) copyFileSync(daily(f, 1), daily(f, day));
  const before = readFileSync(daily(f, 8));
  assert.equal(
    (await backupProduction({ root: f.root, now: at(8) })).status,
    "existing",
  );
  assert.equal(files(f).length, 7);
  assert.equal(existsSync(daily(f, 1)), false);
  assert.deepEqual(readFileSync(daily(f, 8)), before);
});

test("시계가 되돌아가도 새 행을 담은 이번 확정 파일을 보존하고 나머지에서 오래된 파일을 정리한다", async (t) => {
  const f = fixture(t);
  for (let day = 2; day <= 8; day++)
    await backupProduction({ root: f.root, now: at(day) });
  f.db.exec("INSERT INTO sample VALUES (2, 'clock rollback')");
  const rows = f.db.prepare("SELECT * FROM sample").all();
  const result = await backupProduction({ root: f.root, now: at(1) });
  assert.equal(result.status, "created");
  assert.ok(existsSync(daily(f, 1)));
  assert.equal(files(f).length, 7);
  assert.equal(existsSync(daily(f, 2)), false);
  for (let day = 3; day <= 8; day++) assert.ok(existsSync(daily(f, day)));
  const restored = new Database(daily(f, 1), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.deepEqual(restored.prepare("SELECT * FROM sample").all(), rows);
    assert.equal(restored.pragma("quick_check", { simple: true }), "ok");
  } finally {
    restored.close();
  }
  const before = readFileSync(daily(f, 1));
  assert.equal(
    (await backupProduction({ root: f.root, now: at(1) })).status,
    "existing",
  );
  assert.deepEqual(readFileSync(daily(f, 1)), before);
  assert.equal(files(f).length, 7);
  assert.deepEqual(f.db.prepare("SELECT * FROM sample").all(), rows);
});

test("원본의 sidecar 경로가 링크이면 외부 경로를 열지 않는다", async (t) => {
  const f = fixture(t);
  const external = mkdtempSync(join(tmpdir(), "backup-sidecar-"));
  t.after(() => cleanupOwned(external, "backup-sidecar-"));
  writeFileSync(join(external, "preserve.txt"), "preserve");
  symlinkSync(external, `${f.source}-journal`, "junction");
  await assert.rejects(
    backupProduction({ root: f.root, now: at(1) }),
    /unsafe-link/,
  );
  assert.equal(
    readFileSync(join(external, "preserve.txt"), "utf8"),
    "preserve",
  );
  assert.deepEqual(readdirSync(f.directory), []);
  unlinkSync(`${f.source}-journal`);
});

test("보관 범위는 검증된 일일 일반 파일 최근 7개이며 수동 파일·하위 폴더·링크는 보존한다", async (t) => {
  const f = fixture(t);
  await backupProduction({ root: f.root, now: at(1) });
  const manual = join(f.directory, "manual.sqlite");
  copyFileSync(daily(f, 1), manual);
  writeFileSync(join(f.directory, "production-2026-09-01.sqlite"), "invalid");
  writeFileSync(
    join(f.directory, "production-2026-99-99.sqlite"),
    "invalid date",
  );
  mkdirSync(join(f.directory, "production-2026-09-02.sqlite"));
  const linked = join(f.directory, "production-2026-09-03.sqlite");
  linkSync(manual, linked);
  const junction = join(f.directory, "production-2026-09-04.sqlite");
  symlinkSync(join(f.root, "data/production"), junction, "junction");
  for (let day = 2; day <= 10; day++)
    await backupProduction({ root: f.root, now: at(day) });
  assert.equal(existsSync(daily(f, 1)), false);
  for (let day = 4; day <= 10; day++) assert.ok(existsSync(daily(f, day)));
  assert.ok(existsSync(manual));
  assert.equal(
    readFileSync(join(f.directory, "production-2026-09-01.sqlite"), "utf8"),
    "invalid",
  );
  assert.ok(
    statSync(join(f.directory, "production-2026-09-02.sqlite")).isDirectory(),
  );
  assert.ok(existsSync(linked));
  assert.ok(existsSync(junction));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sample").get().n, 1);
});

test("원본 위치를 벗어난 DATABASE_PATH는 거절한다", async (t) => {
  const f = fixture(t);
  const external = mkdtempSync(join(tmpdir(), "backup-external-"));
  t.after(() => cleanupOwned(external, "backup-external-"));
  const db = new Database(join(external, "outside.sqlite"));
  db.exec("CREATE TABLE sample (id INTEGER)");
  db.close();
  for (const path of [
    join(external, "outside.sqlite"),
    "data/production-backups/manual.sqlite",
    "data/production/../../outside.sqlite",
  ]) {
    writeFileSync(f.config, JSON.stringify({ DATABASE_PATH: path }));
    await assert.rejects(backupProduction({ root: f.root, now: at(1) }));
  }
  assert.deepEqual(readdirSync(f.directory), []);
});

test("대상 폴더가 외부 또는 원본으로 향하는 junction이면 쓰거나 삭제하지 않는다", async (t) => {
  const f = fixture(t);
  const external = mkdtempSync(join(tmpdir(), "backup-external-"));
  t.after(() => cleanupOwned(external, "backup-external-"));
  for (const target of [external, join(f.root, "data/production")]) {
    rmdirSync(f.directory);
    symlinkSync(target, f.directory, "junction");
    await assert.rejects(
      backupProduction({ root: f.root, now: at(1) }),
      /unsafe-link/,
    );
    assert.equal(
      existsSync(join(target, "production-2026-10-01.sqlite")),
      false,
    );
    unlinkSync(f.directory);
    mkdirSync(f.directory);
  }
  assert.deepEqual(readdirSync(external), []);
});

test("허용 폴더 밖의 별칭과 원본 하드 링크를 거절한다", async (t) => {
  const f = fixture(t);
  symlinkSync(
    join(f.root, "data/production"),
    join(f.root, "data/alias"),
    "junction",
  );
  writeFileSync(
    f.config,
    JSON.stringify({ DATABASE_PATH: "data/alias/forum.sqlite" }),
  );
  await assert.rejects(backupProduction({ root: f.root, now: at(1) }));
  writeFileSync(
    f.config,
    JSON.stringify({ DATABASE_PATH: "data/production/forum.sqlite" }),
  );
  linkSync(f.source, join(f.directory, "source-link.sqlite"));
  await assert.rejects(
    backupProduction({ root: f.root, now: at(1) }),
    /unsafe-file/,
  );
  assert.equal(files(f).length, 0);
});

test("원본 경로 안의 외부 junction과 설정 폴더의 junction을 거절한다", async (t) => {
  const f = fixture(t);
  const external = mkdtempSync(join(tmpdir(), "backup-external-"));
  t.after(() => cleanupOwned(external, "backup-external-"));
  const outside = join(external, "outside.sqlite");
  const db = new Database(outside);
  db.exec("CREATE TABLE sample (id INTEGER)");
  db.close();
  const before = readFileSync(outside);
  symlinkSync(external, join(f.root, "data/production/linked"), "junction");
  writeFileSync(
    f.config,
    JSON.stringify({ DATABASE_PATH: "data/production/linked/outside.sqlite" }),
  );
  await assert.rejects(
    backupProduction({ root: f.root, now: at(1) }),
    /unsafe-link/,
  );
  const deployment = join(f.root, "data/deployment");
  unlinkSync(f.config);
  rmdirSync(deployment);
  writeFileSync(
    join(external, "runtime-env.json"),
    JSON.stringify({ DATABASE_PATH: f.source }),
  );
  symlinkSync(external, deployment, "junction");
  await assert.rejects(
    backupProduction({ root: f.root, now: at(1) }),
    /unsafe-link/,
  );
  assert.deepEqual(readFileSync(outside), before);
  assert.deepEqual(readdirSync(f.directory), []);
});

test("확정 이름이 원본 하드 링크 또는 junction이면 원본을 보존하고 거절한다", async (t) => {
  const f = fixture(t);
  linkSync(f.source, daily(f, 1));
  const before = readFileSync(f.source);
  await assert.rejects(
    backupProduction({ root: f.root, now: at(1) }),
    /unsafe-file/,
  );
  assert.deepEqual(readFileSync(f.source), before);
  unlinkSync(daily(f, 1));
  symlinkSync(join(f.root, "data/production"), daily(f, 1), "junction");
  await assert.rejects(
    backupProduction({ root: f.root, now: at(1) }),
    /unsafe-link/,
  );
  assert.deepEqual(readFileSync(f.source), before);
});

const backupModule = pathToFileURL(
  join(import.meta.dirname, "production-backup.mjs"),
).href;
function childBackup(t, f, day, hook = "") {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const root = ${JSON.stringify(f.root)};
${hook}
syncBuiltinESMExports();
const { backupProduction } = await import(${JSON.stringify(backupModule)});
try {
  const result = await backupProduction({ root, now: new Date(${JSON.stringify(at(day).toISOString())}) });
  console.log(result.status);
} catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
`,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const finished = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      done({ code, stdout: stdout.trim(), stderr: stderr.trim() }),
    );
  });
  f.children.push({ child, finished });
  return { child, finished };
}
async function waitFor(path) {
  const deadline = Date.now() + 15000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, "자식 프로세스 표식 시간 초과");
    await new Promise((done) => setTimeout(done, 25));
  }
}
const pauseAfterLink = `
const original = fs.linkSync;
fs.linkSync = (...args) => {
  original(...args);
  fs.writeFileSync(root + '/linked', 'ready');
  const until = Date.now() + 15000;
  while (!fs.existsSync(root + '/release')) {
    if (Date.now() > until) throw new Error('test-timeout');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
};`;

test("독립 프로세스는 확정·기존 검증·보관 정리가 끝날 때까지 같은 저장소 잠금을 기다린다", async (t) => {
  const f = fixture(t);
  await backupProduction({ root: f.root, now: at(1) });
  for (let day = 2; day <= 7; day++) copyFileSync(daily(f, 1), daily(f, day));
  const first = childBackup(t, f, 8, pauseAfterLink);
  await waitFor(join(f.root, "linked"));
  assert.equal(statSync(daily(f, 8)).nlink, 2);
  const second = childBackup(t, f, 8);
  const third = childBackup(
    t,
    f,
    9,
    `
const open = fs.openSync;
fs.openSync = (path, ...args) => {
  if (String(path).includes('.partial-')) fs.writeFileSync(root + '/copying', 'started');
  return open(path, ...args);
};`,
  );
  let secondDone = false;
  second.finished.then(() => {
    secondDone = true;
  });
  await new Promise((done) => setTimeout(done, 1500));
  assert.equal(secondDone, false);
  assert.equal(existsSync(join(f.root, "copying")), false);
  assert.ok(existsSync(daily(f, 1)));
  writeFileSync(join(f.root, "release"), "go");
  assert.deepEqual(await first.finished, {
    code: 0,
    stdout: "created",
    stderr: "",
  });
  assert.deepEqual(await second.finished, {
    code: 0,
    stdout: "existing",
    stderr: "",
  });
  assert.deepEqual(await third.finished, {
    code: 0,
    stdout: "created",
    stderr: "",
  });
  assert.equal(files(f).length, 7);
  assert.equal(statSync(daily(f, 8)).nlink, 1);
});

test("확정 링크 직후 소유 프로세스가 죽어도 OS 잠금을 해제하고 UUID 부분 링크만 복구한다", async (t) => {
  const f = fixture(t);
  const first = childBackup(t, f, 1, pauseAfterLink);
  await waitFor(join(f.root, "linked"));
  const before = readFileSync(daily(f, 1));
  first.child.kill();
  await first.finished;
  assert.equal(statSync(daily(f, 1)).nlink, 2);
  assert.equal(
    (await backupProduction({ root: f.root, now: at(1) })).status,
    "existing",
  );
  assert.equal(statSync(daily(f, 1)).nlink, 1);
  assert.deepEqual(readFileSync(daily(f, 1)), before);
  assert.equal(
    readdirSync(f.directory).some((name) => name.startsWith(".partial-")),
    false,
  );
});

test("확정 후 부분 링크 삭제 EBUSY를 원래 오류로 보고하고 다음 날짜 호출도 복구한다", async (t) => {
  const f = fixture(t);
  const first = childBackup(
    t,
    f,
    1,
    `
const unlink = fs.unlinkSync;
fs.unlinkSync = (path) => {
  if (String(path).includes('.partial-')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  return unlink(path);
};`,
  );
  assert.deepEqual(await first.finished, {
    code: 1,
    stdout: "",
    stderr: "EBUSY",
  });
  assert.equal(statSync(daily(f, 1)).nlink, 2);
  const before = readFileSync(daily(f, 1));
  await backupProduction({ root: f.root, now: at(2) });
  assert.equal(statSync(daily(f, 1)).nlink, 1);
  assert.deepEqual(readFileSync(daily(f, 1)), before);
});

const captureHelper = `
const cp = (await import('node:child_process')).default;
const spawnHelper = cp.spawn;
let helper;
cp.spawn = (...args) => { helper = spawnHelper(...args); return helper; };
`;
for (const stage of ["progress", "exited", "finalize"]) {
  test(`mutex 헬퍼 상실(${stage})은 확정·보관을 중단하고 종료 대기가 멈추지 않는다`, async (t) => {
    const f = fixture(t);
    await backupProduction({ root: f.root, now: at(1) });
    const before = readFileSync(daily(f, 1));
    const hook =
      stage === "finalize"
        ? `
const sync = fs.fsyncSync;
fs.fsyncSync = (...args) => { sync(...args); helper.kill(); };
`
        : `
const Database = (await import('better-sqlite3')).default;
const backup = Database.prototype.backup;
Database.prototype.backup = async function(path, options) {
  ${
    stage === "progress"
      ? `
  const progress = options.progress;
  options.progress = (...args) => { helper.kill(); return progress(...args); };
  return backup.call(this, path, options);
  `
      : `
  const result = await backup.call(this, path, options);
  helper.kill();
  await new Promise((done) => helper.once('exit', done));
  return result;
  `
  }
};`;
    const runner = childBackup(t, f, 2, captureHelper + hook);
    const result = await Promise.race([
      runner.finished,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("헬퍼 종료 대기 시간 초과")),
          15000,
        );
        timer.unref();
        runner.finished.finally(() => clearTimeout(timer));
      }),
    ]);
    assert.deepEqual(result, {
      code: 1,
      stdout: "",
      stderr: "backup-mutex-lost",
    });
    assert.equal(existsSync(daily(f, 2)), false);
    assert.deepEqual(readFileSync(daily(f, 1)), before);
    assert.equal(
      (await backupProduction({ root: f.root, now: at(2) })).status,
      "created",
    );
  });
}

test("UUID 이름만으로 손상된 사본·무관한 링크·세 링크를 복구하거나 삭제하지 않는다", async (t) => {
  const f = fixture(t);
  await backupProduction({ root: f.root, now: at(1) });
  const foreign = join(f.directory, ".partial-not-a-uuid.sqlite");
  linkSync(daily(f, 1), foreign);
  await assert.rejects(
    backupProduction({ root: f.root, now: at(1) }),
    /unsafe-file/,
  );
  unlinkSync(foreign);
  const partial = join(f.directory, `.partial-${randomUUID()}.sqlite`);
  linkSync(daily(f, 1), partial);
  linkSync(daily(f, 1), foreign);
  await assert.rejects(
    backupProduction({ root: f.root, now: at(1) }),
    /unsafe-file/,
  );
  assert.ok(existsSync(partial));
  unlinkSync(partial);
  unlinkSync(foreign);
  writeFileSync(daily(f, 2), "invalid");
  linkSync(daily(f, 2), partial);
  await assert.rejects(
    backupProduction({ root: f.root, now: at(2) }),
    /invalid-backup/,
  );
  assert.ok(existsSync(partial));
  assert.equal(readFileSync(daily(f, 2), "utf8"), "invalid");
});

function ps(script) {
  const result = spawnSync(
    join(
      process.env.SystemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        "$ErrorActionPreference = 'Stop'; " + script,
        "utf16le",
      ).toString("base64"),
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const psPath = (path) => `'${path.replaceAll("'", "''")}'`;
function acl(path, directory = false) {
  return ps(
    `[System.IO.${directory ? "Directory" : "File"}]::GetAccessControl(${psPath(path)}).Sddl`,
  );
}
function assertPrivate(path, directory = false) {
  const descriptor = ps(`
$acl = [System.IO.${directory ? "Directory" : "File"}]::GetAccessControl(${psPath(path)})
$allowed = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (!$acl.AreAccessRulesProtected) { throw 'inheritance-enabled' }
foreach ($rule in $rules) { if ($rule.IsInherited -or $rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { throw 'broad-access' } }
if (!$rules.Count) { throw 'empty-acl' }
$acl.Sddl`);
  assert.ok(descriptor.includes("D:P"));
}

test("넓은 부모 ACL과 제한된 원본에서도 복사 전에 백업 경로·기존 파일·부분 파일 DACL을 제한한다", async (t) => {
  const f = fixture(t);
  const parent = join(f.root, "data");
  ps(`
$parent = ${psPath(parent)}
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($user)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
[System.IO.Directory]::SetAccessControl($parent, $acl)
$file = [System.Security.AccessControl.FileSecurity]::new()
$file.SetAccessRuleProtection($true, $false)
$file.SetOwner($user)
$file.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'Allow'))
[System.IO.File]::SetAccessControl(${psPath(f.source)}, $file)
`);
  rmdirSync(f.directory);
  mkdirSync(f.directory);
  assert.ok(acl(f.directory, true).includes("WD"));
  // 제한된 원본과 달리 기존 사본에는 넓은 부모 권한이 상속되는 상황을 합성한다.
  f.db.pragma("wal_checkpoint(FULL)");
  copyFileSync(f.source, daily(f, 1));
  assert.ok(acl(daily(f, 1)).includes("WD"));
  const foreign = join(f.root, "foreign.txt");
  writeFileSync(foreign, "foreign");
  linkSync(foreign, join(f.directory, "manual-hardlink.sqlite"));
  symlinkSync(
    join(f.root, "data/production"),
    join(f.directory, "foreign-junction"),
    "junction",
  );
  const foreignBefore = acl(foreign);
  const productionBefore = acl(join(f.root, "data/production"), true);
  const parentBefore = acl(parent, true);
  const sourceBefore = acl(f.source);
  const original = Database.prototype.backup;
  let observed = false;
  Database.prototype.backup = function (path, options) {
    assertPrivate(f.directory, true);
    assertPrivate(daily(f, 1));
    assertPrivate(path);
    observed = true;
    return original.call(this, path, options);
  };
  try {
    await backupProduction({ root: f.root, now: at(2) });
  } finally {
    Database.prototype.backup = original;
  }
  assert.ok(observed);
  assertPrivate(daily(f, 2));
  assert.equal(acl(parent, true), parentBefore);
  assert.equal(acl(f.source), sourceBefore);
  assert.equal(acl(foreign), foreignBefore);
  assert.equal(acl(join(f.root, "data/production"), true), productionBefore);
});

test("중단된 부분 파일 96개가 있어도 권한을 묶음 검증하고 같은 날·다음 날 백업한다", async (t) => {
  const f = fixture(t);
  await backupProduction({ root: f.root, now: at(1) });
  const before = readFileSync(daily(f, 1));
  const partials = Array.from({ length: 96 }, () =>
    join(f.directory, `.partial-${randomUUID()}.sqlite`),
  );
  for (const path of partials) writeFileSync(path, "unfinished fixture");
  assert.equal(
    (await backupProduction({ root: f.root, now: at(1) })).status,
    "existing",
  );
  assert.equal(
    (await backupProduction({ root: f.root, now: at(2) })).status,
    "created",
  );
  assert.deepEqual(readFileSync(daily(f, 1)), before);
  assert.equal(
    partials.every(
      (path) => readFileSync(path, "utf8") === "unfinished fixture",
    ),
    true,
  );
  assertPrivate(partials[0]);
  assertPrivate(partials.at(-1));
  assertPrivate(daily(f, 2));
});

test("CLI 날짜는 선택적 단일 --day와 유효한 달력 날짜만 허용한다", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "scripts"));
  const script = join(f.root, "scripts/production-backup.mjs");
  writeFileSync(
    script,
    readFileSync(
      new URL("./production-backup.mjs", import.meta.url),
      "utf8",
    ).replace(
      'from "better-sqlite3"',
      `from ${JSON.stringify(import.meta.resolve("better-sqlite3"))}`,
    ),
  );
  for (const args of [
    ["--day"],
    ["--day", "2026-02-30"],
    ["--day", "2026-10-01", "--day", "2026-10-02"],
    ["--other"],
    ["2026-10-01"],
    ["--day", "2026-1-01"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      windowsHide: true,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.deepEqual(readdirSync(f.directory), []);
  }
  const valid = spawnSync(process.execPath, [script, "--day", "2026-10-01"], {
    windowsHide: true,
    encoding: "utf8",
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.ok(existsSync(daily(f, 1)));
  const manual = spawnSync(process.execPath, [script], {
    windowsHide: true,
    encoding: "utf8",
  });
  assert.equal(manual.status, 0, manual.stderr);
  assert.ok(
    existsSync(
      join(
        f.directory,
        `production-${new Date().toISOString().slice(0, 10)}.sqlite`,
      ),
    ),
  );
});
