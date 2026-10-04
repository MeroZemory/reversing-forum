import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const active = new Map();
const dailyName = /^production-(\d{4}-\d{2}-\d{2})\.sqlite$/;
const partialName =
  /^\.partial-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite$/;
const powershell = join(
  process.env.SystemRoot || "C:/Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const encoded = (value) => Buffer.from(value, "utf16le").toString("base64");

// stdin의 EOF가 소유 프로세스 수명과 연결된다. 디스크 잠금 파일은 만들지 않는다.
async function acquireBackupMutex(root) {
  if (process.platform !== "win32") throw new Error("windows-backup-required");
  const name =
    "Global\\reversing-forum-backup-" +
    createHash("sha256").update(root.toLowerCase()).digest("hex");
  const helper = spawn(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encoded(`
$ErrorActionPreference = 'Stop'
$mutex = [System.Threading.Mutex]::new($false, ${literal(name)})
$held = $false
$owner = [System.Diagnostics.Process]::GetProcessById(${process.pid})
try {
  while (!$held -and !$owner.HasExited) {
    try { $held = $mutex.WaitOne(200) } catch [System.Threading.AbandonedMutexException] { $held = $true }
  }
  if ($owner.HasExited) { exit 0 }
  [Console]::Out.WriteLine('acquired')
  [Console]::Out.Flush()
  [Console]::In.ReadToEnd() | Out-Null
} finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose(); $owner.Dispose() }
`),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  helper.stdin.on("error", () => {});
  await new Promise((ready, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      helper.stdin.destroy();
      helper.kill();
      reject(new Error("backup-mutex-timeout"));
    }, 60000);
    helper.once("error", () => {
      clearTimeout(timer);
      reject(new Error("backup-mutex-unavailable"));
    });
    helper.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("backup-mutex-unavailable"));
    });
    helper.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.trim() === "acquired") {
        clearTimeout(timer);
        ready();
      }
    });
  });
  return helper;
}

function restrictBackupAcl(root, paths, links = 1) {
  const entries = (Array.isArray(paths) ? paths : [paths]).map((path) => ({
    path,
    info: checked(
      root,
      path,
      entry(path)?.isDirectory() ? "directory" : "file",
      links,
    ),
  }));
  if (!entries.length) return;
  const command = (batch) =>
    encoded(`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BackupFileSecurity {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetFileSecurity(string path, uint information, byte[] descriptor);
}
'@
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$sids = @($user.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
foreach ($path in @(${batch.map(({ path }) => literal(path)).join(",")})) {
if ([System.IO.File]::GetAttributes($path) -band [System.IO.FileAttributes]::ReparsePoint) { throw 'unsafe-reparse' }
$directory = [System.IO.Directory]::Exists($path)
$acl = if ($directory) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($user)
$inherit = if ($directory) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
foreach ($sid in $sids) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid), [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
# 부모 DACL만 설정한다. SetSecurityInfo 계열의 기존 자식 자동 전파는 피한다.
# 기존 소유권은 유지하고 보호된 DACL만 설정한다.
if (![BackupFileSecurity]::SetFileSecurity($path, [uint32]2147483652, $acl.GetSecurityDescriptorBinaryForm())) { throw 'acl-write-failed' }
$actual = if ($directory) { [System.IO.Directory]::GetAccessControl($path) } else { [System.IO.File]::GetAccessControl($path) }
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value -or $rules.Count -ne $sids.Count) { throw 'unsafe-acl' }
foreach ($rule in $rules) {
  if ($rule.IsInherited -or $rule.IdentityReference.Value -notin $sids -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne 'None') { throw 'unsafe-acl' }
}
}
`);
  // Windows 명령 길이 제한에 여유를 두고 실제 인코딩 길이로 나눈다.
  const batches = [];
  let batch = [];
  for (const item of entries) {
    if (command([...batch, item]).length > 24000) {
      if (batch.length) batches.push(batch);
      batch = [];
      if (command([item]).length > 24000) throw new Error("unsafe-backup-acl");
    }
    batch.push(item);
  }
  if (batch.length) batches.push(batch);
  for (const items of batches) {
    const result = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", command(items)],
      { windowsHide: true, stdio: "ignore", timeout: 15000 },
    );
    if (result.error || result.status !== 0)
      throw new Error("unsafe-backup-acl");
  }
  for (const { path, info } of entries) {
    const after = checked(
      root,
      path,
      info.isDirectory() ? "directory" : "file",
      links,
    );
    if (after.dev !== info.dev || after.ino !== info.ino)
      throw new Error("unsafe-file");
  }
}
const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

function entry(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// 열기·삭제 전에 junction을 포함한 모든 경로 구성 요소를 확인한다.
function checked(root, path, kind, links = 1) {
  const parts = relative(root, path).split(sep);
  if (isAbsolute(relative(root, path)) || parts.includes("..") || !parts[0])
    throw new Error("unsafe-path");
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !samePath(realpathSync(current), current))
      throw new Error("unsafe-link");
  }
  const info = lstatSync(path);
  if (
    kind === "directory"
      ? !info.isDirectory()
      : !info.isFile() || info.nlink !== links
  )
    throw new Error("unsafe-file");
  return info;
}

function validate(root, path, links = 1) {
  checked(root, path, "file", links);
  const fd = openSync(path, "r");
  const header = Buffer.alloc(20);
  try {
    if (
      readSync(fd, header, 0, 20, 0) !== 20 ||
      header.subarray(0, 16).toString() !== "SQLite format 3\0" ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      throw new Error("invalid-backup");
  } finally {
    closeSync(fd);
  }
  // 확정 파일은 단일 파일이어야 하며 외부 sidecar를 열지 않는다.
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (entry(`${path}${suffix}`)) throw new Error("unexpected-sidecar");
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const check = db.pragma("quick_check");
    if (
      check.length !== 1 ||
      check[0].quick_check !== "ok" ||
      db.pragma("foreign_key_check").length !== 0
    )
      throw new Error("invalid-backup");
  } finally {
    db.close();
  }
}

function recoverCommitted(root, directory, assertLock) {
  assertLock();
  const names = readdirSync(directory);
  for (const name of names) {
    const match = dailyName.exec(name);
    if (!match || !validDay(match[1])) continue;
    const final = join(directory, name);
    if (entry(final)?.nlink !== 2) continue;
    const info = checked(root, final, "file", 2);
    for (const partial of names.filter((name) => partialName.test(name))) {
      const path = join(directory, partial);
      const candidate = entry(path);
      if (
        !candidate ||
        candidate.dev !== info.dev ||
        candidate.ino !== info.ino
      )
        continue;
      checked(root, path, "file", 2);
      validate(root, final, 2);
      restrictBackupAcl(root, final, 2);
      const current = checked(root, path, "file", 2);
      const committed = checked(root, final, "file", 2);
      if (
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        committed.dev !== info.dev ||
        committed.ino !== info.ino
      )
        throw new Error("unsafe-file");
      assertLock();
      unlinkSync(path);
      validate(root, final);
      break;
    }
  }
}

function validDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === day
  );
}

function retain(root, directory, protectedName, assertLock) {
  assertLock();
  const confirmed = [];
  checked(root, directory, "directory");
  for (const name of readdirSync(directory)) {
    const match = dailyName.exec(name);
    if (!match || !validDay(match[1])) continue;
    const path = join(directory, name);
    try {
      validate(root, path);
      confirmed.push(name);
    } catch {
      /* 무관하거나 잘못된 파일은 보존한다. */
    }
  }
  // 시계가 되돌아가도 이번 호출의 확정 파일은 보존하고 나머지 최신 6개를 남긴다.
  for (const name of confirmed
    .filter((name) => name !== protectedName)
    .sort()
    .reverse()
    .slice(6)) {
    const path = join(directory, name);
    validate(root, path);
    assertLock();
    unlinkSync(path);
  }
}

async function createBackup(root, day, assertLock) {
  assertLock();
  if (!validDay(day)) throw new Error("invalid-day");
  checked(root, join(root, "data"), "directory");
  const config = join(root, "data/deployment/runtime-env.json");
  checked(root, config, "file");
  const { DATABASE_PATH } = JSON.parse(readFileSync(config, "utf8"));
  if (typeof DATABASE_PATH !== "string" || !DATABASE_PATH.trim())
    throw new Error("database-path-required");
  const source = resolve(root, DATABASE_PATH);
  const production = join(root, "data/production");
  checked(root, production, "directory");
  const sourceRelative = relative(production, source);
  if (
    !sourceRelative ||
    isAbsolute(sourceRelative) ||
    sourceRelative.split(sep).includes("..")
  )
    throw new Error("unsafe-source");
  checked(root, source, "file");
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (entry(`${source}${suffix}`))
      checked(root, `${source}${suffix}`, "file");
  const directory = join(root, "data/production-backups");
  if (!entry(directory)) mkdirSync(directory);
  checked(root, directory, "directory");
  restrictBackupAcl(root, directory);
  recoverCommitted(root, directory, assertLock);
  const recognized = [];
  for (const name of readdirSync(directory)) {
    const match = dailyName.exec(name);
    if (!(match && validDay(match[1])) && !partialName.test(name)) continue;
    const path = join(directory, name);
    // 링크·폴더·수동 파일의 ACL은 변경하지 않는다.
    try {
      checked(root, path, "file");
    } catch {
      continue;
    }
    recognized.push(path);
  }
  restrictBackupAcl(root, recognized);
  assertLock();
  const filename = `production-${day}.sqlite`;
  const final = join(directory, filename);
  // 손상되거나 링크인 일일 파일은 실패로 처리하며 덮어쓰지 않는다.
  if (entry(final)) {
    validate(root, final);
    retain(root, directory, filename, assertLock);
    assertLock();
    return { status: "existing", filename };
  }
  const temporary = join(directory, `.partial-${randomUUID()}.sqlite`);
  const fd = openSync(temporary, "wx", 0o600);
  closeSync(fd);
  const identity = statSync(temporary);
  let failure;
  try {
    restrictBackupAcl(root, temporary);
    assertLock();
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
      await db.backup(temporary, {
        progress: () => {
          assertLock();
          checked(root, source, "file");
          checked(root, temporary, "file");
        },
      });
    } finally {
      db.close();
    }
    assertLock();
    // WAL 설정은 사본에서만 해제하여 확정 파일 자체로 복구할 수 있게 한다.
    checked(root, temporary, "file");
    const copy = new Database(temporary, { fileMustExist: true });
    try {
      copy.pragma("journal_mode = DELETE");
    } finally {
      copy.close();
    }
    validate(root, temporary);
    const syncFd = openSync(temporary, "r+");
    try {
      fsyncSync(syncFd);
    } finally {
      closeSync(syncFd);
    }
    checked(root, directory, "directory");
    // 하드 링크로 확정하면 기존 이름이 있을 때 원자적으로 거절한다.
    assertLock();
    linkSync(temporary, final);
    assertLock();
    unlinkSync(temporary);
    validate(root, final);
    retain(root, directory, filename, assertLock);
    assertLock();
    return { status: "created", filename };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // 중단된 부분 파일은 재사용하지 않고 이번 호출이 만든 일반 파일만 제거한다.
    try {
      if (entry(temporary)) {
        assertLock();
        const info = checked(root, temporary, "file");
        if (info.dev === identity.dev && info.ino === identity.ino)
          unlinkSync(temporary);
      }
    } catch (error) {
      if (!failure) throw error;
    }
  }
}

export function backupProduction({
  root = resolve(import.meta.dirname, ".."),
  now = new Date(),
} = {}) {
  root = realpathSync(root);
  if (active.has(root)) return active.get(root);
  const pending = (async () => {
    const helper = await acquireBackupMutex(root);
    const assertLock = () => {
      if (
        helper.exitCode !== null ||
        helper.signalCode !== null ||
        helper.killed
      )
        throw new Error("backup-mutex-lost");
      try {
        process.kill(helper.pid, 0);
      } catch {
        throw new Error("backup-mutex-lost");
      }
    };
    try {
      return await createBackup(
        root,
        now.toISOString().slice(0, 10),
        assertLock,
      );
    } finally {
      helper.stdin.end();
      await new Promise((done) => {
        if (helper.exitCode !== null || helper.signalCode !== null) done();
        else helper.once("exit", done);
      });
    }
  })().finally(() => active.delete(root));
  active.set(root, pending);
  return pending;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  let now = new Date();
  const args = process.argv.slice(2);
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--day" || !validDay(args[1])) {
      console.error("백업-실패: 잘못된 날짜 인수");
      process.exitCode = 1;
    } else now = new Date(`${args[1]}T00:00:00Z`);
  }
  if (!process.exitCode)
    backupProduction({ now })
      .then(({ status, filename }) => {
        console.log(
          `${new Date().toISOString()} 백업-${status === "created" ? "생성" : "기존"} ${filename}`,
        );
      })
      .catch(() => {
        console.error(`${new Date().toISOString()} 백업-실패`);
        process.exitCode = 1;
      });
}
