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
  it("백업 간 중복 대응이 불확실해도 각 원본의 질문과 답변 순서는 보존한다", () => {
    const { db, minimized, add } = fixture();
    try {
      add("a-q", 1, "2025-02-01T10:00", "source-a", "동일표시명");
      add("b-q", 2, "2025-02-01T10:00", "source-b", "동일표시명");
      add("a-r", 3, "2025-02-01T10:01", "source-a", "동일표시명");
      add("b-r", 4, "2025-02-01T10:01", "source-b", "동일표시명");
      for (const evidence of minimized.values())
        evidence.duplicateAmbiguous = true;
      const value = editorialEvidence(
        db,
        ["b-r", "a-r", "b-q", "a-q"],
        minimized,
      );
      expect(value.evidence.map((m) => [m.id, m.segment])).toEqual([
        ["a-q", 0],
        ["a-r", 0],
        ["b-q", 1],
        ["b-r", 1],
      ]);
      expect(value.evidence.every((m) => m.duplicateAmbiguous)).toBe(true);
      expect(value.evidence[0].speaker).toBe(value.evidence[1].speaker);
      expect(value.evidence[2].speaker).toBe(value.evidence[3].speaker);
      expect(value.evidence[0].speaker).not.toBe(value.evidence[2].speaker);
      expect(JSON.stringify(value)).not.toMatch(
        /source-a|source-b|동일표시명|messageOrder/,
      );
    } finally {
      db.close();
    }
  });

  it("각 원본의 순서대로 묶어도 날짜·시간 역행·긴 간격 경계를 합치지 않는다", () => {
    const { db, minimized, add } = fixture();
    try {
      add("q", 1, "2025-02-01T10:01");
      add("backward", 2, "2025-02-01T10:00");
      add("later", 3, "2025-02-01T11:00");
      add("next-day", 4, "2025-02-02T11:01");
      for (const evidence of minimized.values())
        evidence.duplicateAmbiguous = true;
      const value = editorialEvidence(db, [...minimized.keys()], minimized);
      expect(value.evidence.map((m) => m.segment)).toEqual([0, 1, 2, 3]);
    } finally {
      db.close();
    }
  });

  it("순서 정보가 없는 근거를 앞으로 옮겨 질문과 답변 사이의 경계를 지우지 않는다", () => {
    const { db, minimized, add } = fixture();
    try {
      add("q", 1, "2025-02-01T10:00");
      add("unknown", 2, "2025-02-01T10:01");
      add("r", 3, "2025-02-01T10:02");
      const change = db.prepare(
        "UPDATE ledger SET record=json_set(record,'$.message.order',?) WHERE id=?",
      );
      change.run(10, "q");
      change.run(null, "unknown");
      change.run(11, "r");
      const value = editorialEvidence(db, [...minimized.keys()], minimized);
      expect(value.evidence.map((m) => [m.id, m.segment])).toEqual([
        ["q", 0],
        ["unknown", 1],
        ["r", 2],
      ]);
    } finally {
      db.close();
    }
  });

  it("해시나 같은 분의 시각보다 백업 파일에 기록된 원래 순서를 우선한다", () => {
    const { db, minimized, add } = fixture();
    try {
      add("r", 1, "2025-02-01T10:00");
      add("q", 2, "2025-02-01T10:00");
      const change = db.prepare(
        "UPDATE ledger SET record=json_set(record,'$.message.order',?) WHERE id=?",
      );
      change.run(11, "r");
      change.run(10, "q");
      const value = editorialEvidence(db, ["r", "q"], minimized);
      expect(value.evidence.map((m) => [m.id, m.segment])).toEqual([
        ["q", 0],
        ["r", 0],
      ]);
    } finally {
      db.close();
    }
  });

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
