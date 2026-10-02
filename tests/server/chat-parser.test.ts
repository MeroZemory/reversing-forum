import { describe, expect, it } from "vitest";
import { parseChat } from "../../src/server/chat-pipeline/parser";
import { dedupeChats } from "../../src/server/chat-pipeline/dedupe";

const encode = (text: string) => new TextEncoder().encode(text);
const parse = (text: string, id = "synthetic") =>
  parseChat({ id, bytes: encode(text) });
const day = "--------------- 2026년 10월 2일 금요일 ---------------";
const sequence = [
  "[가람] [오전 9:01] 질문",
  "[나래] [오전 9:02] 제안",
  "[가람] [오전 9:03] 결과",
];

describe("카톡 파서", () => {
  it("닉네임 안의 대괄호를 메시지 본문과 구분한다", () => {
    const result = parse(
      `${day}\n[가람 [분석]] [오전 9:01] 분석 질문\n[나래] [오전 9:02] 확인 제안`,
    );
    expect(result.messages.map((m) => m.author)).toEqual([
      "가람 [분석]",
      "나래",
    ]);
    expect(result.messages[0].body).toBe("분석 질문");
  });
  it.each(["", "\ufeff"])("BOM과 모든 바이트 및 행을 설명한다: %j", (bom) => {
    const text = `${bom}연습방 카카오톡 대화\r\n저장한 날짜 : 2026-10-02\r\n${day}\r\n[가람] [오전 9:01] 안녕\r\n`;
    const result = parse(text);
    expect(result.unparsed).toEqual([]);
    expect(result.source.hasBom).toBe(Boolean(bom));
    expect(result.manifest.coverage).toEqual({
      complete: true,
      coveredBytes: encode(text).length,
      coveredLines: 4,
    });
    let cursor = 0;
    for (const range of result.classifiedRanges) {
      expect(range.byteStart).toBe(cursor);
      cursor = range.byteEnd;
    }
    const message = result.messages[0];
    expect(
      new TextDecoder().decode(
        result.source.bytes.subarray(
          message.range.byteStart,
          message.range.byteEnd,
        ),
      ),
    ).toBe("[가람] [오전 9:01] 안녕\r\n");
    expect(message.range.lineStart).toBe(4);
  });

  it("두 형식과 자정, 정오, 초 정밀도를 보존한다", () => {
    const result = parse(
      `${day}\n[가람] [오전 12:00] 자정\n[나래] [오후 12:00] 정오\n2026년 10월 3일 오전 1:02:03, 다온 : 초\n2026. 10. 3. 23:59, 다온 : 밤`,
    );
    expect(result.source.format).toBe("mixed");
    expect(result.messages.map((message) => message.timestamp)).toEqual([
      { local: "2026-10-02T00:00", precision: "minute" },
      { local: "2026-10-02T12:00", precision: "minute" },
      { local: "2026-10-03T01:02:03", precision: "second" },
      { local: "2026-10-03T23:59", precision: "minute" },
    ]);
    expect(result.messages.map((message) => message.order)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("여러 줄 코드의 공백과 헤더 모양 본문을 그대로 보존한다", () => {
    const body =
      "코드\r\n```text\r\n  mov eax, 1\r\n[가람] [오전 9:05] 인용\r\n2026년 10월 2일 오전 9:06, 나래 : 인용\r\n```\r\n끝";
    const result = parse(
      `${day}\r\n[가람] [오전 9:01] ${body}\r\n[나래] [오전 9:07] 다음`,
    );
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].body).toBe(body);
    expect(result.messages[0].issues).toContain("header-like-body");
    expect(result.messages[0].issues).not.toContain("possible-truncation");
  });

  it("들여쓴 헤더 유사 문자열은 본문으로 유지한다", () => {
    const result = parse(
      `${day}\n[가람] [오전 9:01] 예제\n  [나래] [오후 1:00] 인용\n[나래] [오전 9:02] 답`,
    );
    expect(result.messages[0].body).toBe("예제\n  [나래] [오후 1:00] 인용");
    expect(result.messages).toHaveLength(2);
  });

  it("미해석, 잘린 헤더와 잘못된 시각을 버리지 않는다", () => {
    const result = parse(
      `알 수 없는 머리말\n${day}\n[가람] [오전 9:01] 본문\n[나래] [오전 9:\n2026년 2월 30일 오전 9:00, 가람 : 날짜 오류\n[다온] [오후 13:00] 시각 오류`,
    );
    expect(result.unparsed).toHaveLength(4);
    expect(result.messages).toHaveLength(1);
    expect(result.manifest.requiresReview).toBe(true);
    expect(result.manifest.coverage.complete).toBe(true);
  });

  it("날짜를 알 수 없는 메시지에는 시각을 만들지 않는다", () => {
    const result = parse("[가람] [오전 9:01] 본문");
    expect(result.messages[0].timestamp).toBeNull();
    expect(result.messages[0].issues).toContain("missing-date");
  });

  it("시스템 항목과 없는 첨부 및 잘린 첨부를 표시한다", () => {
    const result = parse(
      `${day}\n가람님이 들어왔습니다.\n[가람] [오전 9:01] 사진\n[나래] [오전 9:02] [첨부: 보고서\n2026년 10월 2일 오전 9:03, 나래님이 나갔습니다.`,
    );
    expect(
      result.classifiedRanges.filter((range) => range.kind === "system"),
    ).toHaveLength(2);
    expect(
      result.classifiedRanges.filter((range) => range.kind === "system")[1],
    ).toMatchObject({
      timestamp: { local: "2026-10-02T09:03", precision: "minute" },
      order: 4,
    });
    expect(result.messages[0].attachments[0].available).toBe(false);
    expect(result.messages[1].issues).toEqual([
      "missing-attachment",
      "possible-truncation",
    ]);
    expect(result.manifest.coverage.complete).toBe(true);
  });

  it("끝나지 않은 코드 블록을 표시한다", () => {
    const result = parse(
      `${day}\n[가람] [오전 9:01] 코드\n~~~ts\nconst value = 1;`,
    );
    expect(result.messages[0].issues).toContain("possible-truncation");
    expect(result.messages[0].fenceIssues?.[0]).toMatchObject({
      reason: "unclosed",
      range: { lineStart: 3, lineEnd: 4 },
    });
  });

  it("닫히지 않은 코드 뒤 날짜 경계에서 복구하고 원본 구간을 남긴다", () => {
    const text = `${day}\n[가람] [오전 9:01] 코드\n\`\`\`ts\nconst value = 1;\n--------------- 2026년 10월 3일 토요일 ---------------\n[나래] [오전 9:02] 다음 날\n[다온] [오전 9:03] 확인`;
    const result = parse(text);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].body).toBe("코드\n```ts\nconst value = 1;");
    expect(result.messages[0].fenceIssues?.[0]).toMatchObject({
      reason: "recovered",
      range: { lineStart: 3, lineEnd: 4 },
      resumedAt: { lineStart: 5, lineEnd: 5 },
    });
    const trace = result.messages[0].fenceIssues![0].range;
    expect(
      new TextDecoder().decode(
        result.source.bytes.subarray(trace.byteStart, trace.byteEnd),
      ),
    ).toBe("```ts\nconst value = 1;\n");
    expect(result.messages[1].issues).toContain("fence-recovered");
    expect(result.messages[2].timestamp?.local).toBe("2026-10-03T09:03");
    expect(result.manifest.coverage.complete).toBe(true);
    expect(result.manifest.requiresReview).toBe(true);
    expect(parse(text)).toEqual(result);
  });

  it("날짜 경계가 없어도 연속된 유효한 같은 형식 헤더로 복구한다", () => {
    for (const format of ["bracket", "inline"] as const) {
      const text =
        format === "bracket"
          ? `${day}\n[가람] [오전 9:01] 코드\n\`\`\`\nconst value = 1;\n[나래] [오전 9:02] 다음\n여러 줄\n[다온] [오전 9:03] 확인`
          : "2026년 10월 2일 오전 9:01, 가람 : 코드\n```\nconst value = 1;\n2026년 10월 2일 오전 9:02, 나래 : 다음\n여러 줄\n2026년 10월 2일 오전 9:03, 다온 : 확인";
      const result = parse(text);
      expect(result.messages).toHaveLength(3);
      expect(result.messages[1].body).toBe("다음\n여러 줄");
      expect(result.messages[0].issues).toEqual([
        "possible-truncation",
        "fence-recovered",
      ]);
      expect(result.messages[0].fenceIssues?.[0].reason).toBe("recovered");
      expect(result.manifest.coverage.complete).toBe(true);
    }
  });

  it("단일 인용 헤더와 역순 시각만으로 코드를 복구하지 않는다", () => {
    for (const suffix of [
      "[나래] [오전 9:02] 인용",
      "[나래] [오전 9:02] 인용\n[다온] [오전 9:01] 이전",
    ]) {
      const result = parse(
        `${day}\n[가람] [오전 9:01] 코드\n\`\`\`\n${suffix}`,
      );
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].issues).toContain("header-like-body");
      expect(result.messages[0].issues).not.toContain("fence-recovered");
      expect(result.messages[0].fenceIssues?.[0].reason).toBe("unclosed");
    }
  });

  it("짧게 닫힌 코드의 날짜 구분자와 내보내기 예제는 보존한다", () => {
    const body = `코드\n\`\`\`text\n${day}\n[나래] [오전 9:02] 인용\n[다온] [오전 9:03] 인용\n\`\`\``;
    const result = parse(
      `${day}\n[가람] [오전 9:01] ${body}\n[나래] [오전 9:04] 실제 다음`,
    );
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].body).toBe(body);
    expect(result.messages[0].issues).not.toContain("fence-recovered");
    expect(result.messages[0].fenceIssues).toBeUndefined();
  });

  it("먼 미래의 닫는 기호 때문에 긴 코드가 실제 헤더를 계속 흡수하지 않는다", () => {
    const content = Array.from(
      { length: 300 },
      (_, index) => `코드 행 ${index}`,
    ).join("\n");
    const result = parse(
      `${day}\n[가람] [오전 9:01] 코드\n\`\`\`\n${content}\n2017-04-23 일요일\n[나래] [오전 9:02] 이후\n[다온] [오전 9:03] 확인\n\`\`\``,
    );
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].fenceIssues?.[0]).toMatchObject({
      reason: "recovered",
      range: { lineStart: 3, lineEnd: 303 },
      resumedAt: { lineStart: 304 },
    });
    expect(result.messages[2].timestamp?.local).toBe("2017-04-23T09:03");
    expect(result.manifest.requiresReview).toBe(true);
    expect(result.manifest.coverage.complete).toBe(true);
  });

  it("전달받은 날짜 구분자와 요일이 있는 시각을 분류한다", () => {
    const result = parse(
      "2017년 4월 23일 일요일 오후 12:55\n2017년 4월 23일 일요일 오후 12:56, 가람 : 본문\n2017-04-24 월요일\n[나래] [오전 12:00] 다음 날",
    );
    expect(result.unparsed).toEqual([]);
    expect(result.messages).toHaveLength(2);
    expect(result.classifiedRanges[0]).toMatchObject({
      kind: "date",
      timestamp: { local: "2017-04-23T12:55", precision: "minute" },
    });
    expect(result.messages[1].timestamp?.local).toBe("2017-04-24T00:00");
    expect(result.source.format).toBe("mixed");
  });

  it("참여자 시스템 문구는 알려진 동작만 분류한다", () => {
    const result = parse(
      `${day}\n참여자님이 채팅방에 들어왔습니다.\n2017년 4월 23일 일요일 오후 12:55, 참여자님이 대화방을 나갔습니다.\n참여자님이 나래님을 초대하였습니다.\n참여자님이 분석한 결과입니다.`,
    );
    expect(
      result.classifiedRanges.filter((range) => range.kind === "system"),
    ).toHaveLength(3);
    expect(result.unparsed).toHaveLength(1);
    expect(result.unparsed[0].text).toBe("참여자님이 분석한 결과입니다.");
  });

  it("닫히지 않은 코드 이후 오천 메시지와 마지막 날짜가 복구된다", () => {
    const lines = Array.from(
      { length: 5000 },
      (_, index) => `2026년 10월 1일 오전 9:01, 나래 : 합성 발언 ${index}`,
    );
    const result = parse(
      `2026년 6월 1일 오전 9:01, 가람 : 코드\n\`\`\`ts\nconst value = 1;\n${lines.join("\n")}`,
    );
    expect(result.messages).toHaveLength(5001);
    expect(result.messages.at(-1)?.timestamp?.local).toBe("2026-10-01T09:01");
    expect(result.messages.at(-1)?.body).toBe("합성 발언 4999");
    expect(result.messages[0].fenceIssues?.[0].reason).toBe("recovered");
    expect(result.unparsed).toEqual([]);
    expect(result.manifest.coverage.complete).toBe(true);
    expect(result.manifest.requiresReview).toBe(true);
  });

  it("코드 안의 첨부와 시스템 표식은 본문으로 유지한다", () => {
    const result = parse(
      `${day}\n[가람] [오전 9:01] 코드\n\`\`\`text\n사진\n다온님이 들어왔습니다.\n\`\`\`\n[나래] [오전 9:02] 다음`,
    );
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].body).toBe(
      "코드\n```text\n사진\n다온님이 들어왔습니다.\n```",
    );
    expect(result.messages[0].attachments).toEqual([]);
    expect(result.messages[0].issues).toEqual([]);
    expect(
      result.classifiedRanges.some(
        (range) => range.kind === "system" || range.kind === "attachment",
      ),
    ).toBe(false);
  });

  it("발언자의 시스템 문구 인용을 시스템 이벤트로 바꾸지 않는다", () => {
    const result = parse(
      `${day}\n[가람] [오전 9:01] 삭제된 메시지입니다.\n이 문구가 표시됩니다.`,
    );
    expect(result.messages[0].body).toBe(
      "삭제된 메시지입니다.\n이 문구가 표시됩니다.",
    );
    expect(
      result.classifiedRanges.some((range) => range.kind === "system"),
    ).toBe(false);
  });

  it("깨진 UTF-8을 미해석으로 보관하고 원본 바이트를 유지한다", () => {
    const bytes = new Uint8Array([
      0xff,
      0x0a,
      ...encode(`${day}\n[가람] [오전 9:01] 본문`),
    ]);
    const result = parseChat({ id: "invalid", bytes });
    expect(result.unparsed[0].issues).toEqual(["invalid-utf8"]);
    expect(result.source.bytes).toEqual(bytes);
    expect(result.manifest.coverage.complete).toBe(true);
  });

  it.each(["", "\ufeff", "\n", "\r", "\r\n"])(
    "빈 입력과 줄 끝도 빠짐없이 설명한다: %j",
    (text) => {
      const result = parse(text);
      expect(result.manifest.coverage.complete).toBe(true);
      expect(result.manifest.coverage.coveredBytes).toBe(encode(text).length);
    },
  );

  it("재실행과 호출자 바이트 변경에 독립적인 결과를 만든다", () => {
    const bytes = encode(`${day}\n${sequence.join("\n")}`);
    const result = parseChat({ id: "stable", bytes });
    expect(parseChat({ id: "stable", bytes })).toEqual(result);
    bytes[0] = 0;
    expect(result.source.bytes[0]).not.toBe(0);
    expect(result.source).not.toHaveProperty("filename");
  });
});

describe("겹친 백업 대응", () => {
  it("복구된 코드 경계의 출현은 확정 중복으로 처리하지 않는다", () => {
    const last = "[나래] [오전 9:04] 추가";
    const left = parse(
      `${day}\n${sequence[0]}\n\`\`\`ts\nconst value = 1;\n${sequence.slice(1).join("\n")}\n${last}`,
      "repair-a",
    );
    const right = parse(`${day}\n${sequence.join("\n")}\n${last}`, "repair-b");
    const result = dedupeChats([left, right]);
    expect(left.messages).toHaveLength(4);
    expect(result.groups).toHaveLength(8);
    expect(result.candidates).toHaveLength(3);
    expect(
      result.candidates.every((candidate) => candidate.status === "ambiguous"),
    ).toBe(true);
    expect(result.independentSupportCount).toBeNull();
  });
  it("두 내보내기 형식 간에도 같은 날짜와 순서를 대응한다", () => {
    const left = parse(`${day}\n${sequence.join("\n")}`, "bracket");
    const right = parse(
      "2026년 10월 2일 오전 9:01, 가람 : 질문\n2026년 10월 2일 오전 9:02, 나래 : 제안\n2026년 10월 2일 오전 9:03, 가람 : 결과",
      "inline",
    );
    const result = dedupeChats([left, right]);
    expect(result.groups).toHaveLength(3);
    expect(
      result.groups.every((group) => group.occurrenceIds.length === 2),
    ).toBe(true);
    expect(
      result.candidates.every((candidate) => candidate.status === "matched"),
    ).toBe(true);
  });

  it("백업당 만 메시지에서도 원본 전체와 중간 미해석 경계를 보존한다", () => {
    const lines = Array.from(
      { length: 10000 },
      (_, index) => `[가람] [오전 9:01] 합성 발언 ${index}`,
    );
    const left = parse(
      `${day}\n${lines.slice(0, 5000).join("\n")}\n[잘린 헤더] [오전\n${lines.slice(5000).join("\n")}`,
      "large-a",
    );
    const right = parse(`${day}\n${lines.join("\n")}`, "large-b");
    const result = dedupeChats([left, right]);
    expect(result.groups.flatMap((group) => group.occurrenceIds)).toHaveLength(
      20000,
    );
    expect(
      result.groups.filter((group) => group.occurrenceIds.length === 1),
    ).toHaveLength(8);
    expect(
      result.candidates.filter((candidate) => candidate.status === "ambiguous"),
    ).toHaveLength(4);
    expect(left.manifest.coverage.complete).toBe(true);
    expect(right.manifest.coverage.complete).toBe(true);
  });
  it("세 백업의 부분 겹침을 연결하며 모든 출현을 보존한다", () => {
    const extra = "[나래] [오전 9:04] 추가";
    const chats = [
      parse(`${day}\n${sequence.join("\n")}`, "a"),
      parse(`${day}\n${sequence.join("\n")}\n${extra}`, "b"),
      parse(`${day}\n${sequence.join("\n")}\n${extra}`, "c"),
    ];
    const result = dedupeChats(chats);
    expect(
      result.groups.filter((group) => group.occurrenceIds.length === 3),
    ).toHaveLength(3);
    expect(result.groups.flatMap((group) => group.occurrenceIds)).toHaveLength(
      11,
    );
    expect(result.independentSupportCount).toBeNull();
    expect(dedupeChats([...chats].reverse())).toEqual(result);
    expect(dedupeChats(chats)).toEqual(result);
  });

  it("같은 백업과 다른 날의 실제 반복을 합치지 않는다", () => {
    const text = `${day}\n${sequence.join("\n")}\n${sequence.join("\n")}\n--------------- 2026년 10월 3일 토요일 ---------------\n${sequence.join("\n")}`;
    const one = parse(text, "a");
    expect(dedupeChats([one]).groups).toHaveLength(9);
    const result = dedupeChats([
      one,
      parse(`${day}\n${sequence.join("\n")}`, "b"),
    ]);
    expect(result.groups).toHaveLength(12);
    expect(
      result.candidates.every((candidate) => candidate.status === "ambiguous"),
    ).toBe(true);
  });

  it("닉네임 변화는 같은 사람이나 확정 중복으로 처리하지 않는다", () => {
    const result = dedupeChats([
      parse(`${day}\n${sequence.join("\n")}`, "a"),
      parse(`${day}\n${sequence.join("\n").replaceAll("가람", "새이름")}`, "b"),
    ]);
    expect(result.groups).toHaveLength(6);
    expect(result.candidates).toHaveLength(3);
    expect(
      result.candidates.every(
        (candidate) => candidate.reason === "alias-or-incomplete",
      ),
    ).toBe(true);
  });

  it("같은 분의 동일 문장은 주변 구간이 달라도 불확실하게 남긴다", () => {
    const repeated = "[가람] [오전 9:01] 질문";
    const result = dedupeChats([
      parse(`${day}\n${sequence.join("\n")}\n${repeated}`, "a"),
      parse(`${day}\n${sequence.join("\n")}`, "b"),
    ]);
    expect(result.groups).toHaveLength(7);
    expect(
      result.candidates.every(
        (candidate) => candidate.reason === "repeated-context",
      ),
    ).toBe(true);
  });

  it("맥락이 짧거나 날짜가 다른 본문 일치는 합치지 않는다", () => {
    const result = dedupeChats([
      parse(`${day}\n${sequence.slice(0, 2).join("\n")}`, "a"),
      parse(`${day}\n${sequence.join("\n")}`, "b"),
      parse(
        `--------------- 2026년 10월 3일 토요일 ---------------\n${sequence.join("\n")}`,
        "c",
      ),
    ]);
    expect(result.groups).toHaveLength(8);
    expect(result.candidates).toEqual([]);
  });

  it("소스 식별자가 중복되면 명시적으로 거절한다", () => {
    expect(() => dedupeChats([parse(day), parse(day)])).toThrow(
      "duplicate-chat-source-id",
    );
  });

  it("중간의 미해석 행이나 시스템 항목을 넘어 확정 대응하지 않는다", () => {
    for (const separator of [
      "[알 수 없음] [잘린 시각",
      "다온님이 들어왔습니다.",
    ]) {
      const left = parse(
        `${day}\n${sequence[0]}\n${separator}\n${sequence.slice(1).join("\n")}`,
        "a",
      );
      const right = parse(`${day}\n${sequence.join("\n")}`, "b");
      const result = dedupeChats([left, right]);
      expect(result.groups).toHaveLength(6);
      expect(
        result.candidates.every(
          (candidate) => candidate.status === "ambiguous",
        ),
      ).toBe(true);
    }
  });
});
