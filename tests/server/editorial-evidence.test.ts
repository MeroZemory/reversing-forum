import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  editorialEvidence,
  type EditorialEvidence,
} from "../../src/server/chat-pipeline/editorial-evidence";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY, active INTEGER);
    INSERT INTO runs VALUES('active',1),('old',0);
    CREATE TABLE ledger(run_id TEXT,id TEXT,position INTEGER,record TEXT,PRIMARY KEY(run_id,id));`);
  const minimized = new Map<string, EditorialEvidence>();
  function add(
    id: string,
    position: number,
    local: string,
    source = "private-backup",
    author = "비공개닉네임",
  ) {
    db.prepare("INSERT INTO ledger VALUES(?,?,?,?)").run(
      "active",
      id,
      position,
      JSON.stringify({
        message: {
          timestamp: { local },
          sourceId: source,
          order: position,
          author,
          body: "원문비공개",
        },
      }),
    );
    minimized.set(id, {
      id,
      speaker: "발언자1",
      text: "최소화된 기술 근거",
      held: false,
      duplicateAmbiguous: false,
      attachmentMissing: false,
    });
  }
  return { db, minimized, add };
}

describe("편집 근거의 순서와 구간", () => {
  it("질문 우선·해시 순서 대신 실제 원본 순서와 숫자 구간만 전달한다", () => {
    const { db, minimized, add } = fixture();
    try {
      add("z-question", 1, "2025-02-01T10:00");
      add("a-response", 2, "2025-02-01T10:01");
      add("b-other", 3, "2025-02-02T10:01", "other-private-backup");
      const value = editorialEvidence(
        db,
        ["b-other", "a-response", "z-question", "a-response"],
        minimized,
      );
      expect(value.evidence.map((m) => [m.id, m.segment])).toEqual([
        ["z-question", 0],
        ["a-response", 0],
        ["b-other", 1],
      ]);
      expect(value.period).toBe("2025년 2월");
      expect(JSON.stringify(value)).not.toMatch(
        /private-backup|비공개닉네임|원문비공개|2025-02|sourceId|messageOrder|position/,
      );
    } finally {
      db.close();
    }
  });

  it("누락·보류 근거를 제거해 바뀐 질답으로 만드는 대신 중단한다", () => {
    const { db, minimized, add } = fixture();
    try {
      add("q", 0, "2025-01-01T10:00");
      expect(() => editorialEvidence(db, ["q", "missing"], minimized)).toThrow(
        "editorial-evidence-unavailable",
      );
      minimized.get("q")!.held = true;
      expect(() => editorialEvidence(db, ["q"], minimized)).toThrow(
        "editorial-evidence-unavailable",
      );
    } finally {
      db.close();
    }
  });
  it("서로 다른 배치의 같은 임시 별칭을 실제 같은 발언자로 합치지 않는다", () => {
    const { db, minimized, add } = fixture();
    try {
      add("q", 0, "2025-01-01T10:00", "private-backup", "원본작성자하나");
      add("r", 1, "2025-01-01T10:01", "private-backup", "원본작성자둘");
      add("follow", 2, "2025-01-01T10:02", "private-backup", "원본작성자하나");
      const value = editorialEvidence(db, ["q", "r", "follow"], minimized);
      expect(value.evidence.map((m) => m.speaker)).toEqual([
        "발언자1",
        "발언자2",
        "발언자1",
      ]);
      expect(JSON.stringify(value)).not.toMatch(
        /원본작성자|author|private-backup/,
      );
    } finally {
      db.close();
    }
  });
});
