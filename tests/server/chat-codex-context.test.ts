import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  candidateRelativeContext,
  codexPrompt,
  stopCodexProcess,
  relativeSegmentStarts,
} from "../../src/server/chat-pipeline/relative-context";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY, active INTEGER);
    INSERT INTO runs VALUES ('active',1),('old',0);
    CREATE TABLE ledger(run_id TEXT, id TEXT, record TEXT, PRIMARY KEY(run_id,id));
    CREATE TABLE jobs(run_id TEXT, id TEXT, record TEXT, PRIMARY KEY(run_id,id));`);
  function add(
    id: string,
    local: string | null,
    sourceId = "private-backup-name.txt",
    order = 0,
    run = "active",
  ) {
    db.prepare("INSERT INTO ledger VALUES (?,?,?)").run(
      run,
      id,
      JSON.stringify({
        message: {
          timestamp: local === null ? null : { local },
          sourceId,
          order,
          author: "절대노출금지원본닉네임",
          body: "절대로드금지원문",
        },
      }),
    );
  }
  function job(ids: string[]) {
    db.prepare("INSERT INTO jobs VALUES (?,?,?)").run(
      "active",
      "block",
      JSON.stringify({
        input: {
          messages: ids.map((id) => ({
            id,
            text: "절대로드금지원문",
            speaker: "원본이름",
          })),
        },
      }),
    );
  }
  return { db, add, job };
}

describe("후보 상대 구간", () => {
  it("순수 헬퍼는 정렬된 투영 행을 변경하지 않고 숫자 경계만 반환한다", () => {
    const projections = [
      {
        position: 9,
        local: "2025-01-01T10:01",
        sourceId: "비공개백업B",
        order: 0,
      },
      {
        position: 3,
        local: "2025-01-01T10:00",
        sourceId: "비공개백업A",
        order: 2,
      },
      {
        position: 4,
        local: "2025-01-01T10:01",
        sourceId: "비공개백업A",
        order: 3,
      },
    ];
    const rows = projections
      .toSorted((a, b) => a.position - b.position)
      .map((row, index) => Object.freeze({ ...row, index }));
    const before = JSON.stringify(rows);
    const starts = relativeSegmentStarts(Object.freeze(rows));
    expect(starts).toEqual([0, 2]);
    expect(JSON.stringify(rows)).toBe(before);
    expect(JSON.stringify(starts)).not.toMatch(
      /비공개|2025|10:01|sourceId|position/,
    );
  });
  it("날짜·큰 간격·백업 전환·역행·누락·오래된 중복을 분리한다", () => {
    const { db, add } = fixture();
    try {
      [
        ["2025-01-01T10:00", "a", 0],
        ["2025-01-01T10:30", "a", 1],
        ["2025-01-01T11:01", "a", 2],
        ["2025-01-02T00:00", "a", 3],
        ["2025-01-02T00:01", "b", 0],
        ["2025-01-02T00:00", "b", 1],
        [null, "b", 2],
        ["2025-01-02T00:02", "b", 3],
        ["2025-01-02T00:03", "b", 1],
        ["2025-01-02T00:04", "b", 4],
        ["2025-01-02T00:05", "b", 3],
        ["2025-01-02T00:06", "b", 5],
      ].forEach(([local, source, order], i) =>
        add(`m${i}`, local as string | null, source as string, order as number),
      );
      const result = candidateRelativeContext(db, {
        batchId: "block",
        messages: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}` })),
      });
      expect(result[0].segmentStarts).toEqual([
        0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
      expect(Object.keys(result[0])).toEqual([
        "batchId",
        "segmentStarts",
        "rule",
      ]);
    } finally {
      db.close();
    }
  });

  it("원래 숫자 별칭을 유지하며 생략·중복 불확실성·블록을 분리한다", () => {
    const { db, add, job } = fixture();
    try {
      for (let i = 0; i < 5; i++)
        add(`m${i}`, `2025-01-01T10:0${i}`, "source", i);
      job(["m0", "m1", "m2", "m3", "m4"]);
      const result = candidateRelativeContext(db, {
        blocks: [
          {
            batchId: "block",
            messages: [
              [0, "익명", "내용", []],
              [2, "익명", "내용", []],
              [3, "익명", "내용", ["duplicate-uncertain"]],
              [4, "익명", "내용", []],
            ],
          },
          { batchId: "block", messages: [[1, "익명", "내용", []]] },
        ],
      });
      expect(result.map((r) => r.segmentStarts)).toEqual([[0, 2, 3, 4], [1]]);
      expect(() =>
        candidateRelativeContext(db, {
          blocks: [{ batchId: "missing", messages: [[0]] }],
        }),
      ).toThrow("context-canonical-id-missing");
    } finally {
      db.close();
    }
  });

  it("활성 run의 필요한 세 컬럼과 ID만 SQL 투영하고 민감한 값을 프롬프트에 추가하지 않는다", () => {
    const { db, add, job } = fixture();
    try {
      add("m0", "2025-01-01T10:00", "private-backup-name.txt", 817);
      add("m1", "2025-01-01T10:01", "private-backup-name.txt", 818);
      add("m1", "2024-01-01T00:00", "old-backup.txt", 0, "old");
      job(["m0", "m1"]);
      const prepare = vi.spyOn(db, "prepare");
      const input = {
        packetId: "unchanged-packet",
        blocks: [
          {
            batchId: "block",
            inputHash: "unchanged-hash",
            messages: [
              [0, "익명", "질문", []],
              [1, "익명", "답변", []],
            ],
          },
        ],
      };
      const source = JSON.stringify(input);
      const context = candidateRelativeContext(db, input);
      expect(context[0].segmentStarts).toEqual([0]);
      const queries = prepare.mock.calls.map(([sql]) => sql);
      expect(queries).toHaveLength(2);
      expect(queries[0]).toContain(
        "WHERE run_id=(SELECT id FROM runs WHERE active=1) AND id=?",
      );
      expect(queries[0].match(/json_extract/g)).toHaveLength(3);
      expect(queries[1]).toContain("json_extract(record, ?) AS id");
      expect(queries.join()).not.toMatch(
        /SELECT\s+(?:\*|record\b)|author|body|speaker|text/i,
      );
      const { prompt, inputHash, actualPromptHash } = codexPrompt(
        source,
        context,
      );
      for (const secret of [
        "2025-01-01",
        "10:00",
        "private-backup-name.txt",
        "old-backup.txt",
        "817",
        "818",
        "절대노출금지원본닉네임",
        "절대로드금지원문",
      ])
        expect(prompt).not.toContain(secret);
      expect(JSON.stringify(input)).toBe(source);
      expect(prompt).toContain(source);
      expect(prompt).toContain("needsContext");
      expect(inputHash).toBe(createHash("sha256").update(source).digest("hex"));
      expect(actualPromptHash).toBe(
        createHash("sha256").update(prompt).digest("hex"),
      );
      expect(actualPromptHash).not.toBe(inputHash);
      const plan = db.prepare("EXPLAIN QUERY PLAN " + queries[0]).all("m0") as {
        detail: string;
      }[];
      expect(
        plan.some((r) =>
          /SEARCH ledger USING INDEX.*run_id=\? AND id=\?/.test(r.detail),
        ),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("읽기 전용 합성 SQLite에서도 조회하며 DB를 변경하지 않는다", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-context-"));
    const path = join(directory, "synthetic.sqlite");
    const { db: memory, add, job } = fixture();
    let readonly: Database.Database | undefined;
    try {
      add("m0", null);
      job(["m0"]);
      await memory.backup(path);
      readonly = new Database(path, { readonly: true, fileMustExist: true });
      expect(
        candidateRelativeContext(readonly, {
          batchId: "block",
          messages: [{ id: "m0" }],
        })[0].segmentStarts,
      ).toEqual([0]);
      expect(() => readonly!.exec("DELETE FROM ledger")).toThrow();
    } finally {
      readonly?.close();
      memory.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("출처 입력과 부가 context를 포함한 실제 프롬프트 모두 500k를 제한한다", () => {
    expect(() => codexPrompt("가".repeat(166_667))).toThrow(
      "codex-input-overflow",
    );
    expect(() =>
      codexPrompt("x".repeat(499_900), [
        { batchId: "b", segmentStarts: [0], rule: "경계" },
      ]),
    ).toThrow("codex-input-overflow");
    expect(codexPrompt("{}").prompt).not.toContain('"context"');
  });
});

describe("CLI 프로세스 중단", () => {
  it("Windows에서는 알려진 PID 트리를 숨긴 execFile로 종료하고 완료를 기다린다", async () => {
    const child = { pid: 1234, kill: vi.fn(() => true) };
    let callback: (error: Error | null) => void = () => {};
    const execute = vi.fn((_file, _args, _options, cb) => {
      callback = cb;
    });
    let completed = false;
    const pending = stopCodexProcess(
      child,
      "win32",
      execute as unknown as typeof execFile,
    ).then(() => {
      completed = true;
    });
    expect(execute.mock.calls[0].slice(0, 3)).toEqual([
      "taskkill",
      ["/PID", "1234", "/T", "/F"],
      { windowsHide: true },
    ]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(completed).toBe(false);
    callback(null);
    await pending;
    expect(completed).toBe(true);
  });

  it("트리 종료 실패를 성공으로 처리하지 않고 PID 없는 호출은 실행하지 않는다", async () => {
    const execute = vi.fn((_file, _args, _options, cb) =>
      cb(new Error("private diagnostic")),
    );
    await expect(
      stopCodexProcess(
        { pid: 1234, kill: () => true },
        "win32",
        execute as unknown as typeof execFile,
      ),
    ).rejects.toThrow("codex-process-tree-stop-failed");
    execute.mockClear();
    await stopCodexProcess(
      { kill: () => true },
      "win32",
      execute as unknown as typeof execFile,
    );
    expect(execute).not.toHaveBeenCalled();
    const kill = vi.fn(() => true);
    await stopCodexProcess({ pid: 1234, kill }, "linux");
    expect(kill).toHaveBeenCalledOnce();
  });
});
