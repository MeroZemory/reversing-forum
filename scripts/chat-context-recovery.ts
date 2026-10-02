import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ChatJobStore,
  contextRecoveryDigest,
  type ContextRecoveryInput,
} from "../src/server/chat-pipeline/job-store";

const maxBytes = 500_000;
function readPrivate(file: string): string {
  if (statSync(file).size > maxBytes)
    throw new Error("context-recovery-file-overflow");
  return readFileSync(file, "utf8");
}
function writePrivate(directory: string, name: string, value: unknown) {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > maxBytes)
    throw new Error("context-recovery-file-overflow");
  const file = join(directory, name);
  // Repeated prepare is safe; different content never overwrites prior evidence.
  try {
    writeFileSync(file, raw, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      readPrivate(file) !== raw
    )
      throw error;
  }
  return { file: name, hash: contextRecoveryDigest(raw) };
}
export function prepareContextRecovery(store: ChatJobStore, directory: string) {
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const inputs = store.listContextRecoveryInputs();
  const packets = inputs.map((input) => ({
    packetId: input.packetId,
    ...writePrivate(directory, `${input.packetId}.input.json`, input),
  }));
  const manifests: Array<{ file: string; hash: string }> = [];
  let chunk: typeof packets = [];
  const flush = () => {
    if (!chunk.length) return;
    const raw = JSON.stringify({ packets: chunk });
    manifests.push(
      writePrivate(directory, `${contextRecoveryDigest(raw)}.manifest.json`, {
        packets: chunk,
      }),
    );
    chunk = [];
  };
  for (const packet of packets) {
    if (
      Buffer.byteLength(JSON.stringify({ packets: [...chunk, packet] })) >
      maxBytes
    )
      flush();
    chunk.push(packet);
  }
  flush();
  const file = join(directory, "manifest.json");
  const previous = existsSync(file)
    ? (JSON.parse(readPrivate(file)) as {
        version: string;
        manifests: typeof manifests;
      })
    : undefined;
  if (
    previous &&
    (previous.version !== "chat-context-recovery-v1" ||
      !Array.isArray(previous.manifests))
  )
    throw new Error("invalid-context-recovery-manifest");
  const combined = [
    ...new Map(
      [...(previous?.manifests ?? []), ...manifests].map((m) => [m.file, m]),
    ).values(),
  ];
  const raw = JSON.stringify({
    version: "chat-context-recovery-v1",
    manifests: combined,
  });
  if (Buffer.byteLength(raw) > maxBytes)
    throw new Error("context-recovery-file-overflow");
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, raw, { mode: 0o600, flag: "wx" });
  renameSync(temp, file);
  return {
    packets: inputs.length,
    manifest: file,
    privateOnly: true,
    executedModels: 0,
  };
}
export function importContextRecoveryOutput(
  store: ChatJobStore,
  directory: string,
  outputFile: string,
) {
  directory = resolve(directory);
  const raw = readPrivate(resolve(outputFile));
  const output = JSON.parse(raw) as { packetId?: unknown };
  if (
    !output ||
    typeof output.packetId !== "string" ||
    !/^[a-f0-9]{64}$/.test(output.packetId)
  )
    throw new Error("invalid-context-recovery-output");
  const manifest = JSON.parse(
    readPrivate(join(directory, "manifest.json")),
  ) as { version: string; manifests: Array<{ file: string; hash: string }> };
  if (
    manifest.version !== "chat-context-recovery-v1" ||
    !Array.isArray(manifest.manifests)
  )
    throw new Error("invalid-context-recovery-manifest");
  const safeName = (name: unknown, suffix: string): string => {
    if (
      typeof name !== "string" ||
      !new RegExp(`^[a-f0-9]{64}\\.${suffix}\\.json$`).test(name)
    )
      throw new Error("invalid-context-recovery-manifest");
    return name;
  };
  const entries = new Map<
    string,
    { packetId: string; file: string; hash: string }
  >();
  for (const part of manifest.manifests) {
    const partRaw = readPrivate(
      join(directory, safeName(part.file, "manifest")),
    );
    if (contextRecoveryDigest(partRaw) !== part.hash)
      throw new Error("context-recovery-manifest-hash-mismatch");
    const shard = JSON.parse(partRaw) as {
      packets: Array<{ packetId: string; file: string; hash: string }>;
    };
    if (!Array.isArray(shard.packets))
      throw new Error("invalid-context-recovery-manifest");
    for (const p of shard.packets.filter(
      (p) => p.packetId === output.packetId,
    )) {
      const existing = entries.get(p.packetId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(p))
        throw new Error("invalid-context-recovery-manifest");
      entries.set(p.packetId, p);
    }
  }
  if (entries.size !== 1) throw new Error("unknown-context-recovery-packet");
  const entry = [...entries.values()][0];
  if (entry.file !== `${output.packetId}.input.json`)
    throw new Error("invalid-context-recovery-manifest");
  const inputRaw = readPrivate(join(directory, safeName(entry.file, "input")));
  if (contextRecoveryDigest(inputRaw) !== entry.hash)
    throw new Error("context-recovery-input-hash-mismatch");
  const input = JSON.parse(inputRaw) as ContextRecoveryInput;
  if (input.packetId !== output.packetId)
    throw new Error("context-recovery-input-hash-mismatch");
  return store.importContextRecovery(input, raw);
}

export function runContextRecovery(args: string[]) {
  const command = args.shift();
  const output = command === "import" ? args.shift() : undefined;
  let storeDirectory = "data/chat-pipeline",
    directory = "data/chat-pipeline/context-recovery";
  while (args.length) {
    const flag = args.shift(),
      value = args.shift();
    if (!value || !["--store", "--directory"].includes(flag ?? ""))
      throw new Error("invalid-context-recovery-arguments");
    if (flag === "--store") storeDirectory = value;
    else directory = value;
  }
  if (!(command === "prepare" || (command === "import" && output)))
    throw new Error(
      "usage: prepare | import OUTPUT [--store DIR] [--directory DIR]",
    );
  const store = new ChatJobStore(storeDirectory);
  try {
    return command === "prepare"
      ? prepareContextRecovery(store, directory)
      : importContextRecoveryOutput(store, directory, output!);
  } finally {
    store.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(JSON.stringify(runContextRecovery(process.argv.slice(2))));
  } catch (error) {
    console.error(
      error instanceof SyntaxError
        ? "invalid-context-recovery-json"
        : error instanceof Error
          ? error.message
          : "context-recovery-failed",
    );
    process.exitCode = 1;
  }
}
