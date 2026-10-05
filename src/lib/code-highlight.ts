export type CodeToken = {
  text: string;
  kind:
    | "plain"
    | "keyword"
    | "register"
    | "number"
    | "string"
    | "comment"
    | "address"
    | "bytes"
    | "label"
    | "function";
};

const registers =
  /^(?:r[abcd]x|r[sd]i|r[sb]p|r(?:8|9|1[0-5])[dwb]?|e[abcd]x|e[sd]i|e[sb]p|[abcd][xlh]|[sd]il?|[sb]pl?|rip|eip|xmm\d+|[cdefgs]s)$/i;
const keywords = new Set(
  "int char void return if else for while unsigned const struct static sizeof long short def import from elif in not and or None True False with as class try except".split(
    " ",
  ),
);

function words(text: string, language: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const pattern =
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\/.*|#[^\n]*|\b0x[\da-f]+\b|\b[\da-f]+h\b|\b\d+\b|\b[a-z_]\w*\b/gi;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    if (start > offset)
      tokens.push({ text: text.slice(offset, start), kind: "plain" });
    const value = match[0];
    const kind: CodeToken["kind"] = /^["']/.test(value)
      ? "string"
      : value.startsWith("//") ||
          (language === "python" && value.startsWith("#"))
        ? "comment"
        : value.startsWith("#") || keywords.has(value)
          ? "keyword"
          : registers.test(value) && ["asm", "disasm"].includes(language)
            ? "register"
            : /^(?:0x[\da-f]+|[\da-f]+h|\d+)$/i.test(value)
              ? "number"
              : text[start + value.length] === "("
                ? "function"
                : "plain";
    tokens.push({ text: value, kind });
    offset = start + value.length;
  }
  if (offset < text.length)
    tokens.push({ text: text.slice(offset), kind: "plain" });
  return tokens;
}

function instruction(line: string, language: string): CodeToken[] {
  const semicolon = line.indexOf(";");
  const text = semicolon < 0 ? line : line.slice(0, semicolon);
  const match = text.match(/^(\s*)(\S+)(\s*)(.*)$/);
  const result: CodeToken[] = match
    ? [
        { text: match[1], kind: "plain" },
        { text: match[2], kind: "keyword" },
        { text: match[3], kind: "plain" },
        ...words(match[4], language),
      ]
    : [{ text, kind: "plain" }];
  if (semicolon >= 0)
    result.push({ text: line.slice(semicolon), kind: "comment" });
  return result;
}

// Text remains text: React escapes it when creating spans. No source HTML is executed.
export function highlightCodeLine(language: string, line: string): CodeToken[] {
  if (["asm", "disasm"].includes(language)) {
    if (/^\S+:\s*$/.test(line)) return [{ text: line, kind: "label" }];
    const match =
      language === "disasm" &&
      line.match(
        /^(\s*)([\da-f`]{6,17})(\s+)((?:[\da-f]{2} )*[\da-f]{2})(\s{2,})(.*)$/i,
      );
    if (match)
      return [
        { text: match[1], kind: "plain" },
        { text: match[2], kind: "address" },
        { text: match[3], kind: "plain" },
        { text: match[4] + match[5], kind: "bytes" },
        ...instruction(match[6], language),
      ];
    return instruction(line, language);
  }
  return [
    "c",
    "cpp",
    "python",
    "shell",
    "json",
    "javascript",
    "typescript",
  ].includes(language)
    ? words(line, language)
    : [{ text: line, kind: "plain" }];
}

export function parseCodeInfo(info: string, lineCount: number) {
  const language = info.match(/^(\w+)/)?.[1].toLowerCase() ?? "text";
  const title = info.match(/title="([^"]*)"/)?.[1] ?? "";
  const highlights = new Set<number>();
  for (const range of (info.match(/\{([\d,\-]+)\}/)?.[1] ?? "").split(",")) {
    const [start, requestedEnd] = range.split("-").map(Number);
    const end = Math.min(requestedEnd ?? start, lineCount);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1)
      continue;
    for (let line = start; line <= end; line++) highlights.add(line);
  }
  return {
    language,
    title,
    highlights: [...highlights],
    numbered: ["c", "cpp", "python"].includes(language) && lineCount > 4,
  };
}
