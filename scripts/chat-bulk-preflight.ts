import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import {
  collectReviewed,
  prepareBulk,
  resolveBulk,
  validateSnapshot,
  type Prepared,
} from "../src/server/chat-pipeline/bulk-duplicates";

// Run with --conditions=react-server for the existing server-only embedding module.
// No env file, server DB module, session, raw chat, budget, LLM or Jev is loaded.
// Manifest: { bundles: [{ bundle: "...bundle.json", review: "...approved.json" }],
//             updates?: { candidateKey: "existing-public-post-id" } }
// Paths inside a manifest are relative to that manifest. Bundle order is batch order.
// Snapshot JSON: { capturedAt: ISO timestamp, posts: [{ id,title,body,tags }] }.
// Explicit snapshots are operator-provided public-only exports, NOT live-state proof.
// prepare --manifest FILE (--db FILE | --snapshot FILE) --out data/.../prepared.json
// resolve --manifest FILE (--db FILE | --snapshot FILE) --prepared FILE
//         --prepared-hash HEX64 --judgments FILE --out data/.../resolved.json
// Preserve prepare stdout.preparedHash in an independent execution record;
// never obtain the trusted --prepared-hash from the prepared file being checked.
// Judgments FILE is an array of BatchJudgment objects, one per prepared.packets.
const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

export function readPublicSnapshot(path: string) {
  // Explicit file only: never create a missing database or initialize tables/indexes.
  const store = new Database(resolve(path), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    store.pragma("query_only = ON");
    return store
      .transaction(() => {
        const rows = store
          .prepare(
            "SELECT id,title,body,tags FROM posts WHERE status='published' ORDER BY id",
          )
          .all() as { id: string; title: string; body: string; tags: string }[];
        return validateSnapshot({
          capturedAt: new Date().toISOString(),
          posts: rows.map((r) => ({ ...r, tags: JSON.parse(r.tags) })),
        });
      })
      .deferred();
  } finally {
    store.close();
  }
}

function privateOutput(path: string) {
  const root = resolve("data"),
    target = resolve(path);
  const inside = (base: string, candidate: string) => {
    const rel = relative(base, candidate);
    return (
      !!rel &&
      !isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..\\`) &&
      !rel.startsWith("../")
    );
  };
  if (!inside(root, target)) throw new Error("output-must-be-private-data");
  // Resolve every existing ancestor, including junctions/symlinks, before mkdir/write.
  const project = realpathSync(resolve("."));
  if (existsSync(root) && realpathSync(root) !== resolve(project, "data"))
    throw new Error("private-data-root-is-link");
  let ancestor = dirname(target);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const physical = resolve(realpathSync(ancestor), relative(ancestor, target));
  if (!inside(resolve(project, "data"), physical))
    throw new Error("output-escapes-private-data");
  if (existsSync(target)) throw new Error("output-already-exists");
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

export async function main(argv: string[]) {
  const [command, ...args] = argv,
    options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      ![
        "--manifest",
        "--db",
        "--snapshot",
        "--out",
        "--prepared",
        "--prepared-hash",
        "--judgments",
      ].includes(key) ||
      !value ||
      value.startsWith("--") ||
      options.has(key)
    )
      throw new Error("invalid-preflight-arguments");
    options.set(key, value);
  }
  if (
    !["prepare", "resolve"].includes(command) ||
    !options.has("--manifest") ||
    !options.has("--out") ||
    options.has("--db") === options.has("--snapshot") ||
    (command === "resolve"
      ? !options.has("--prepared") ||
        !options.has("--judgments") ||
        !/^[a-f0-9]{64}$/i.test(options.get("--prepared-hash") ?? "")
      : options.has("--prepared") ||
        options.has("--judgments") ||
        options.has("--prepared-hash"))
  )
    throw new Error("usage-bulk-preflight-prepare-or-resolve");
  const manifestPath = resolve(options.get("--manifest")!);
  const manifest = read(manifestPath) as {
    bundles: { bundle: string; review: string }[];
    updates?: Record<string, string>;
  };
  if (
    !manifest ||
    !Array.isArray(manifest.bundles) ||
    !manifest.bundles.length ||
    (manifest.updates !== undefined &&
      (!manifest.updates ||
        typeof manifest.updates !== "object" ||
        Array.isArray(manifest.updates)))
  )
    throw new Error("invalid-preflight-manifest");
  const candidates = collectReviewed(
    manifest.bundles.map((pair) => {
      if (
        !pair ||
        typeof pair.bundle !== "string" ||
        typeof pair.review !== "string"
      )
        throw new Error("invalid-bundle-pair");
      return {
        bundle: read(resolve(dirname(manifestPath), pair.bundle)),
        review: read(resolve(dirname(manifestPath), pair.review)),
      };
    }),
  );
  const snapshot = options.has("--db")
    ? readPublicSnapshot(options.get("--db")!)
    : validateSnapshot(read(resolve(options.get("--snapshot")!)));
  let result: unknown;
  if (command === "prepare")
    result = await prepareBulk(candidates, snapshot, manifest.updates ?? {});
  else {
    const prepared = read(resolve(options.get("--prepared")!)) as Prepared;
    // Mapping is part of the immutable prepare input; do not swap it at resolve.
    const updates = manifest.updates ?? {};
    if (JSON.stringify(prepared.updates) !== JSON.stringify(updates))
      throw new Error("update-mapping-changed");
    const judgments = read(resolve(options.get("--judgments")!));
    if (!Array.isArray(judgments)) throw new Error("invalid-judgment-file");
    result = resolveBulk(
      prepared,
      judgments,
      candidates,
      snapshot,
      options.get("--prepared-hash")!,
    );
  }
  const out = privateOutput(options.get("--out")!);
  const snapshotSource = options.has("--db")
    ? "readonly-db"
    : "operator-public-snapshot";
  const output =
    command === "resolve" ? { ...(result as object), snapshotSource } : result;
  writeFileSync(out, JSON.stringify(output, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      output: out,
      ...(command === "prepare"
        ? { preparedHash: (result as Prepared).preparedHash }
        : {}),
      independentPreflightOnly: true,
      siteGateProof: false,
      snapshotSource,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch(() => {
    // Fail without serializing private bodies, DB rows, paths or arbitrary parser errors.
    console.error(
      "bulk-preflight-failed: check arguments, snapshot freshness and exact review bindings",
    );
    process.exitCode = 1;
  });
}
