import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { ChatJobStore } from "../src/server/chat-pipeline/job-store";
import { hash } from "../src/server/chat-pipeline/prepare";
import type { PrepareOptions } from "../src/server/chat-pipeline/prepare";

// Explicit offline CLI. Never loads .env, site DB, keys, or an external model API.
const args = process.argv.slice(2);
const command = args.shift();
function flag(name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error("missing-argument-value");
  args.splice(index, 2);
  return value;
}
let store: ChatJobStore | undefined;
try {
  const directory = flag("--work-dir") ?? "data/chat-pipeline";
  const root = resolve(flag("--root") ?? ".");
  const optionsPath = flag("--options");
  if (!["prepare", "summary", "import-result"].includes(command ?? ""))
    throw new Error(
      "사용법: node --import tsx scripts/chat-pipeline.ts prepare|summary|import-result [배치ID 결과JSON] [--root 경로] [--work-dir 경로] [--options 비공개설정JSON]",
    );
  if (
    (command === "import-result" && args.length !== 2) ||
    (command !== "import-result" && args.length)
  )
    throw new Error("invalid-arguments");
  store = new ChatJobStore(directory);
  if (command === "prepare") {
    const options = optionsPath
      ? (JSON.parse(
          readFileSync(resolve(optionsPath), "utf8"),
        ) as PrepareOptions)
      : {};
    const files = readdirSync(root, { withFileTypes: true })
      .filter((f) => f.isFile() && /^KakaoTalk.*\.txt$/i.test(f.name))
      .map((f) => f.name)
      .sort();
    if (!files.length) throw new Error("no-chat-input-files");
    const result = store.prepare(
      files.map((name) => ({
        id: hash(["source-v1", name]),
        bytes: readFileSync(join(root, name)),
      })),
      options,
    );
    console.log(JSON.stringify(result));
  } else if (command === "summary") {
    console.log(JSON.stringify(store.summary()));
  } else {
    console.log(
      JSON.stringify(
        store.importResult(args[0], readFileSync(resolve(args[1]), "utf8")),
      ),
    );
  }
} catch (error) {
  // Only controlled codes are logged; never echo filesystem paths or raw content.
  const message =
    error instanceof Error ? error.message : "chat-pipeline-failed";
  console.error(
    /^[a-z-]+$/.test(message) || message.startsWith("사용법:")
      ? message
      : "chat-pipeline-failed",
  );
  process.exitCode = 1;
} finally {
  store?.close();
}
