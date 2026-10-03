import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import {
  inspectReferences,
  emitReferences,
  type ReferenceInspection,
} from "../src/server/chat-pipeline/editorial-references";

// All inputs and outputs stay inside the existing private working directory.
function privatePath(file: string, output = false) {
  const expectedRoot = join(
    realpathSync(resolve(".")),
    "data",
    "chat-pipeline",
  );
  const root = realpathSync(expectedRoot);
  if (relative(expectedRoot, root) !== "") throw Error();
  const path = output
    ? join(
        realpathSync(dirname(resolve(file))),
        resolve(file).split(/[\\/]/).at(-1)!,
      )
    : realpathSync(resolve(file));
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error();
  return path;
}
function read(file: string) {
  const text = readFileSync(privatePath(file), "utf8");
  if (Buffer.byteLength(text) > 1_000_000) throw Error();
  return JSON.parse(text);
}
try {
  const [command, ...args] = process.argv.slice(2);
  const database = privatePath("data/chat-pipeline/jobs.sqlite");
  let value: unknown;
  if (command === "inspect" && args.length === 2)
    value = inspectReferences(database, read(args[0]));
  else if (command === "emit" && args.length === 3)
    value = emitReferences(
      database,
      read(args[0]) as ReferenceInspection,
      read(args[1]),
    );
  else throw Error();
  writeFileSync(privatePath(args.at(-1)!, true), JSON.stringify(value), {
    mode: 0o600,
    flag: "wx",
  });
  console.log(JSON.stringify({ complete: true }));
} catch {
  // Never echo exception messages, paths, raw URLs or input data.
  console.error("editorial-references-failed");
  process.exitCode = 1;
}
