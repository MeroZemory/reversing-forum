import { createHash } from "node:crypto";
import type {
  ChatMessage,
  ChatSourceInput,
  ChatTimestamp,
  ParsedChat,
  SourceRange,
} from "./types";

export const CHAT_PARSER_VERSION = "chat-parser-v3";
// Protect short, closed examples; never scan the entire remaining backup per
// opening fence. Beyond this bound, export-shaped boundaries require review.
const fenceLookaheadLines = 256;
const contextLookaheadLines = 64;
const datePattern =
  "(\\d{4})(?:년\\s*|[./-]\\s*)(\\d{1,2})(?:월\\s*|[./-]\\s*)(\\d{1,2})(?:일|\\.)?";
const timePattern = "(오전|오후)?\\s*(\\d{1,2}):(\\d{2})(?::(\\d{2}))?";
const dayHeader = new RegExp(
  `^(?:-{3,}\\s*)?${datePattern}(?:\\s+[가-힣]+요일)?(?:\\s+${timePattern})?\\s*(?:-{3,})?$`,
);
const bracketHeader = new RegExp(
  `^\\[([^\\r\\n]+?)\\] \\[${timePattern}\\] ?(.*)$`,
);
const inlineHeader = new RegExp(
  `^${datePattern}(?:\\s+[가-힣]+요일)?\\s+${timePattern},\\s+(.+?) : ?(.*)$`,
);
const inlineSystem = new RegExp(
  `^${datePattern}(?:\\s+[가-힣]+요일)?\\s+${timePattern},\\s+(.+)$`,
);
const systemPattern =
  /^(?:.+님이 (?:(?:(?:대화방|채팅방)에 )?(?:들어왔습니다|입장했습니다)|(?:(?:대화방|채팅방)을 )?(?:나갔습니다|퇴장했습니다)|.+님을 초대(?:했습니다|하였습니다))|삭제된 메시지입니다|메시지가 삭제되었습니다)[.!]?$/;
const attachmentPattern =
  /^(?:사진(?:\s*\d+장)?|동영상|이모티콘|파일(?:\s*:.+)?|음성메시지|사진을 보냈습니다\.?|동영상을 보냈습니다\.?|\[(?:사진|동영상|파일|첨부)(?:[^\]]*)\]?)$/;

function date(y: string, m: string, d: string): string | null {
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31)
    return null;
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day)
    return null;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function timestamp(
  day: string | null,
  period: string | undefined,
  h: string,
  m: string,
  s?: string,
): ChatTimestamp | null {
  let hour = Number(h);
  if (!day || Number(m) > 59 || (s !== undefined && Number(s) > 59))
    return null;
  if (period) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (period === "오후" ? 12 : 0);
  } else if (hour > 23) return null;
  return {
    local: `${day}T${String(hour).padStart(2, "0")}:${m}${s === undefined ? "" : `:${s}`}`,
    precision: s === undefined ? "minute" : "second",
  };
}

function* followingLines(
  bytes: Uint8Array,
  start: number,
  limit: number,
): Generator<{ text: string; byteStart: number }> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (let count = 0; start < bytes.length && count < limit; count++) {
    const byteStart = start;
    while (start < bytes.length && bytes[start] !== 10 && bytes[start] !== 13)
      start++;
    const contentEnd = start;
    if (start < bytes.length)
      start += bytes[start] === 13 && bytes[start + 1] === 10 ? 2 : 1;
    try {
      yield {
        text: decoder.decode(bytes.subarray(byteStart, contentEnd)),
        byteStart,
      };
    } catch {
      return;
    }
  }
}

function nearbyFenceClose(
  bytes: Uint8Array,
  start: number,
  fence: string,
): number | undefined {
  const closing = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`);
  for (const line of followingLines(bytes, start, fenceLookaheadLines)) {
    if (closing.test(line.text)) return line.byteStart;
  }
}

function corroboratedHeader(
  bytes: Uint8Array,
  start: number,
  time: ChatTimestamp,
  day: string | null,
  format: "bracket" | "inline",
): boolean {
  for (const line of followingLines(bytes, start, contextLookaheadLines)) {
    if (/^\s*(`{3,}|~{3,})/.test(line.text) || dayHeader.test(line.text))
      return false;
    const match = (format === "bracket" ? bracketHeader : inlineHeader).exec(
      line.text,
    );
    if (!match) continue;
    const next =
      format === "bracket"
        ? timestamp(day, match[2], match[3], match[4], match[5])
        : timestamp(
            date(match[1], match[2], match[3]),
            match[4],
            match[5],
            match[6],
            match[7],
          );
    return Boolean(next && next.local >= time.local);
  }
  return false;
}

/** Pure local parsing. Contents are never logged, fetched, or executed. */
export function parseChat(input: ChatSourceInput): ParsedChat {
  if (!input.id) throw new Error("chat-source-id-required");
  const bytes = input.bytes.slice();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const result: ParsedChat = {
    source: { id: input.id, bytes, sha256, hasBom, format: "unknown" },
    messages: [],
    unparsed: [],
    classifiedRanges: [],
    manifest: {
      parserVersion: CHAT_PARSER_VERSION,
      sourceId: input.id,
      sha256,
      byteLength: bytes.length,
      lineCount: 0,
      coverage: { complete: false, coveredBytes: 0, coveredLines: 0 },
      requiresReview: false,
    },
  };
  if (hasBom)
    result.classifiedRanges.push({
      kind: "bom",
      byteStart: 0,
      byteEnd: 3,
      lineStart: 0,
      lineEnd: 0,
    });
  let current: ChatMessage | undefined;
  let currentDay: string | null = null;
  let fence: string | undefined;
  let fenceStart: SourceRange | undefined;
  let protectedFenceClose: number | undefined;
  let pendingRecovery = false;
  function markFence(
    reason: "unclosed" | "recovered",
    resumedAt?: SourceRange,
  ) {
    if (!current || !fenceStart) return;
    current.issues.push("possible-truncation");
    if (reason === "recovered") current.issues.push("fence-recovered");
    (current.fenceIssues ??= []).push({
      range: {
        ...fenceStart,
        byteEnd: current.range.byteEnd,
        lineEnd: current.range.lineEnd,
      },
      reason,
      ...(resumedAt ? { resumedAt: { ...resumedAt } } : {}),
    });
  }
  let previousEnding = "";
  let lineNumber = 0;
  const formats = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (let start = hasBom ? 3 : 0; start < bytes.length;) {
    let end = start;
    while (end < bytes.length && bytes[end] !== 10 && bytes[end] !== 13) end++;
    const contentEnd = end;
    if (end < bytes.length) {
      if (bytes[end] === 13 && bytes[end + 1] === 10) end += 2;
      else end++;
    }
    lineNumber++;
    const range: SourceRange = {
      byteStart: start,
      byteEnd: end,
      lineStart: lineNumber,
      lineEnd: lineNumber,
    };
    const ending =
      contentEnd === end
        ? ""
        : bytes[contentEnd] === 13
          ? end - contentEnd === 2
            ? "\r\n"
            : "\r"
          : "\n";
    let text: string;
    try {
      text = decoder.decode(bytes.subarray(start, contentEnd));
    } catch {
      markFence("unclosed");
      result.unparsed.push({
        text: new TextDecoder().decode(bytes.subarray(start, contentEnd)),
        range,
        issues: ["invalid-utf8"],
      });
      result.classifiedRanges.push({ ...range, kind: "unparsed" });
      current = undefined;
      fence = undefined;
      fenceStart = undefined;
      protectedFenceClose = undefined;
      start = end;
      continue;
    }
    const day = dayHeader.exec(text);
    const validDay = day ? date(day[1], day[2], day[3]) : null;
    const dayTime = day?.[5]
      ? timestamp(validDay, day[4], day[5], day[6], day[7])
      : null;
    const validDayHeader = Boolean(validDay && (!day?.[5] || dayTime));
    const bracket = bracketHeader.exec(text);
    const inline = inlineHeader.exec(text);
    const system = inlineSystem.exec(text);
    const systemTime = system
      ? timestamp(
          date(system[1], system[2], system[3]),
          system[4],
          system[5],
          system[6],
          system[7],
        )
      : null;
    let body: string | undefined;
    let author = "";
    let format: "bracket" | "inline" = "bracket";
    let time: ChatTimestamp | null = null;
    if (bracket) {
      author = bracket[1];
      body = bracket[6];
      time = timestamp(
        currentDay,
        bracket[2],
        bracket[3],
        bracket[4],
        bracket[5],
      );
    } else if (inline) {
      format = "inline";
      author = inline[8];
      body = inline[9];
      time = timestamp(
        date(inline[1], inline[2], inline[3]),
        inline[4],
        inline[5],
        inline[6],
        inline[7],
      );
    }
    if (
      fence &&
      current &&
      protectedFenceClose === undefined &&
      (validDayHeader ||
        (time && corroboratedHeader(bytes, end, time, currentDay, format)))
    ) {
      markFence("recovered", range);
      fence = undefined;
      fenceStart = undefined;
      pendingRecovery = true;
    }
    const wasInFence = Boolean(fence);
    let kind: ParsedChat["classifiedRanges"][number]["kind"];
    if (fence && current) {
      kind = "message";
      if (day || bracket || inline) current.issues.push("header-like-body");
      current.body += previousEnding + text;
      current.range.byteEnd = end;
      current.range.lineEnd = lineNumber;
      if (new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(text)) {
        fence = undefined;
        fenceStart = undefined;
        protectedFenceClose = undefined;
      }
    } else if (validDayHeader) {
      currentDay = validDay;
      current = undefined;
      kind = "date";
    } else if (
      body !== undefined &&
      (time ||
        (bracket &&
          !currentDay &&
          timestamp(
            "2000-01-01",
            bracket[2],
            bracket[3],
            bracket[4],
            bracket[5],
          )))
    ) {
      const occurrenceId = createHash("sha256")
        .update(JSON.stringify([CHAT_PARSER_VERSION, input.id, sha256, start]))
        .digest("hex");
      current = {
        occurrenceId,
        sourceId: input.id,
        order: result.messages.length,
        format,
        author,
        timestamp: time,
        body,
        range: { ...range },
        issues: time ? [] : ["missing-date"],
        attachments: [],
      };
      result.messages.push(current);
      if (pendingRecovery) {
        current.issues.push("fence-recovered");
        pendingRecovery = false;
      }
      formats.add(format);
      kind = "message";
    } else if (
      systemPattern.test(text) ||
      (system && systemTime && systemPattern.test(system[8]))
    ) {
      current = undefined;
      kind = "system";
    } else if (
      /^(?:저장한 날짜\s*:.*|.+ 님과 카카오톡 대화|.+ 카카오톡 대화)$/.test(
        text,
      ) &&
      result.messages.length === 0
    ) {
      current = undefined;
      kind = "header";
    } else if (
      !bracket &&
      !inline &&
      !day &&
      current &&
      !/^\[.+\] \[/.test(text) &&
      !/^\d{4}(?:년|[./-])/.test(text)
    ) {
      kind = "message";
      current.body += previousEnding + text;
      current.range.byteEnd = end;
      current.range.lineEnd = lineNumber;
    } else {
      current = undefined;
      kind = "unparsed";
      if (day) currentDay = null;
      result.unparsed.push({ text, range, issues: ["unrecognized-line"] });
    }
    if (current && kind !== "unparsed") {
      const marker = body === undefined ? text : body;
      if (!wasInFence && attachmentPattern.test(marker)) {
        kind = "attachment";
        current.attachments.push({
          marker,
          range: { ...range },
          available: false,
        });
        current.issues.push("missing-attachment");
        if (marker.startsWith("[") && !marker.endsWith("]"))
          current.issues.push("possible-truncation");
      }
      const opening = /^\s*(`{3,}|~{3,})/.exec(marker);
      if (!wasInFence && opening) {
        fence = opening[1];
        fenceStart = { ...range };
        protectedFenceClose = nearbyFenceClose(bytes, end, fence);
      }
    }
    result.classifiedRanges.push({
      ...range,
      kind,
      ...(current ? { occurrenceId: current.occurrenceId } : {}),
      ...(kind === "date" && dayTime ? { timestamp: dayTime } : {}),
      ...(kind === "system"
        ? {
            occurrenceId:
              current?.occurrenceId ??
              createHash("sha256")
                .update(
                  JSON.stringify([
                    CHAT_PARSER_VERSION,
                    input.id,
                    sha256,
                    start,
                  ]),
                )
                .digest("hex"),
            order: lineNumber - 1,
            text,
            timestamp: current?.timestamp ?? systemTime,
          }
        : {}),
    });
    previousEnding = ending;
    start = end;
  }
  if (fence && current) markFence("unclosed");
  for (const message of result.messages)
    message.issues = [...new Set(message.issues)];
  result.source.format =
    formats.size > 1
      ? "mixed"
      : formats.has("inline")
        ? "inline"
        : formats.has("bracket")
          ? "bracket"
          : "unknown";
  let cursor = 0,
    coveredLines = 0;
  for (const range of result.classifiedRanges) {
    if (range.byteStart !== cursor || range.byteEnd <= range.byteStart)
      throw new Error("chat-coverage-gap");
    cursor = range.byteEnd;
    if (range.kind !== "bom")
      coveredLines += range.lineEnd - range.lineStart + 1;
  }
  result.manifest.lineCount = lineNumber;
  result.manifest.coverage = {
    complete: cursor === bytes.length && coveredLines === lineNumber,
    coveredBytes: cursor,
    coveredLines,
  };
  result.manifest.requiresReview =
    result.unparsed.length > 0 ||
    result.messages.some((message) => message.issues.length > 0);
  return result;
}
