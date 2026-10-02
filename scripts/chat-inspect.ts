import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseChat } from "../src/server/chat-pipeline/parser";

// Local inspection only. Never print messages, authors, source filenames or paths.
const root = resolve(process.cwd());
const target = resolve(root, "data/chat-pipeline");
mkdirSync(target, { recursive: true });
const files = readdirSync(root)
  .filter((name) => /^KakaoTalk.*\.txt$/i.test(name))
  .sort();
const reports = files.map((name, index) => {
  const bytes = readFileSync(resolve(root, name));
  const id = `source-${index + 1}`;
  const parsed = parseChat({ id, bytes });
  const shapes = new Map<string, number>();
  for (const row of parsed.unparsed) {
    // Shapes contain only ASCII punctuation and character-class names.
    const shape = row.text
      .replace(/[가-힣]+/g, "K")
      .replace(/[\p{L}]+/gu, "L")
      .replace(/\d+/g, "D")
      .replace(/[^KLD\s\[\]():,.\-/]/g, "?")
      .slice(0, 100);
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  const report = {
    ...parsed.manifest,
    format: parsed.source.format,
    messages: parsed.messages.length,
    timestamps: parsed.messages.filter((m) => m.timestamp).length,
    unparsed: parsed.unparsed.length,
    dateStart:
      parsed.messages.find((m) => m.timestamp)?.timestamp?.local ?? null,
    dateEnd:
      parsed.messages.findLast((m) => m.timestamp)?.timestamp?.local ?? null,
    missingAttachments: parsed.messages.filter((m) => m.attachments.length)
      .length,
    unparsedShapes: [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
  writeFileSync(
    resolve(target, `${id}-parsed.json`),
    JSON.stringify({
      manifest: parsed.manifest,
      messages: parsed.messages,
      classifiedRanges: parsed.classifiedRanges,
      unparsed: parsed.unparsed,
    }),
  );
  return report;
});
const manifest = {
  inspectedAt: new Date().toISOString(),
  sources: reports,
  sourceBytes: reports.reduce((n, r) => n + r.byteLength, 0),
  sourceMessages: reports.reduce((n, r) => n + r.messages, 0),
  fingerprint: createHash("sha256")
    .update(JSON.stringify(reports.map((r) => r.sha256)))
    .digest("hex"),
};
writeFileSync(
  resolve(target, "inspection.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(JSON.stringify(manifest, null, 2));
