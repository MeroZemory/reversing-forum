import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const versions = {
  basisVersion: "synthetic-basis",
  rightsVersion: "synthetic-rights",
  rulesVersion: "synthetic-rules",
};
const publicData = {
  title: "Synthetic technical guide",
  body: "A synthetic explanation of inspecting a test executable.",
  kind: "share",
  tags: ["synthetic"],
  provenance: {
    type: "independent-guide",
    period: "synthetic-period",
    verificationSummary: "Synthetic test material only.",
  },
};
const publicHash = createHash("sha256")
  .update(JSON.stringify(publicData))
  .digest("hex");

type Existing = {
  hash?: string;
  state?: string;
  screeningStatus?: string | null;
  post?: { id: string; status: string } | null;
  basisVersion?: string;
  rightsVersion?: string;
  rulesVersion?: string;
};
type Call = {
  path: string;
  data: Record<string, unknown> | null;
};

// Exercise the actual CLI in an isolated directory. The preload replaces all
// HTTP; neither the app server nor any screening/model service is contacted.
function run(
  existing: Existing,
  command = "publish",
  publishStatus = 200,
  overrides: {
    bundle?: Record<string, unknown>;
    entry?: Record<string, unknown>;
    verdict?: Record<string, unknown>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "publish-editorial-synthetic-"));
  try {
    const directory = join(root, "data/chat-pipeline");
    mkdirSync(directory, { recursive: true });
    const write = (path: string, data: unknown) =>
      writeFileSync(join(root, path), JSON.stringify(data));
    write("data/chat-pipeline/editorial-session.json", {
      origin: "http://synthetic.invalid",
      cookie: "synthetic-session",
    });
    write("processing.json", {
      scope: "independently-written-nonpersonal-technical-material",
      ...versions,
      permitted: true,
    });
    write("bundle.json", {
      ...versions,
      qualityPolicyVersion: "reusable-technical-knowledge-v3",
      processingRecord: "processing.json",
      ...overrides.bundle,
      entries: [
        {
          candidateKey: "synthetic-candidate",
          needsContext: false,
          sourceAliases: ["synthetic-alias"],
          publicData,
          evidenceIds: ["synthetic-evidence"],
          reviewId: "synthetic-review",
          ...overrides.entry,
        },
      ],
    });
    write("review.json", {
      model: "gpt-6.1-sol",
      effort: "xhigh",
      entries: [
        {
          candidateKey: "synthetic-candidate",
          publicHash,
          passed: true,
          quality: true,
          qualityPolicyVersion: "reusable-technical-knowledge-v3",
          meaning: true,
          privacy: true,
          rights: true,
          externalTransfer: true,
          referenceId: "synthetic-review",
          ...overrides.verdict,
        },
      ],
    });
    const preview = {
      ...versions,
      hash: publicHash,
      revision: 7,
      state: "approved",
      reviewed: true,
      approved: true,
      screeningStatus: "uncertain",
      post: null,
      ...existing,
    };
    const shim = join(root, "fake-http.mjs");
    writeFileSync(
      shim,
      `import { appendFileSync } from 'node:fs';
let preview = ${JSON.stringify(preview)};
const versions = ${JSON.stringify(versions)};
const publicHash = ${JSON.stringify(publicHash)};
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  const data = options.body ? JSON.parse(options.body) : null;
  if (options.headers.Cookie !== 'synthetic-session') throw Error('missing-session');
  if (data && (options.method !== 'POST' || options.headers.Origin !== 'http://synthetic.invalid'))
    throw Error('missing-write-session');
  appendFileSync('calls.jsonl', JSON.stringify({ path, data }) + '\\n');
  if (!data) return Response.json(preview);
  if (path === '/api/editorial' && data.action === 'basis') return Response.json({});
  if (path === '/api/resources/curation' && data.action === 'snapshot') {
    if (preview.state !== 'published' || preview.post?.status !== 'published') throw Error('private-curation');
    return Response.json({ hash: 'synthetic-curation', version: 'synthetic-curation-version', eligibleGuides: [], editorial: preview });
  }
  if (path !== '/api/editorial/synthetic-candidate') throw Error('unexpected-path');
  if (data.action === 'revise') {
    if (data.revision !== preview.revision || data.hash !== preview.hash ||
        Object.keys(versions).some(key => data[key] !== preview[key])) throw Error('stale-revision');
    if (data.draft.revision !== preview.revision + 1) throw Error('wrong-next-revision');
    preview = { ...preview, ...versions, hash: publicHash, revision: data.draft.revision,
      state: 'draft', reviewed: false, approved: false, screeningStatus: null, post: null };
    return Response.json(preview);
  }
  if (data.revision !== preview.revision || data.hash !== preview.hash ||
      Object.keys(versions).some(key => data[key] !== preview[key])) throw Error('stale-target');
  if (data.action === 'review') {
    if (preview.state !== 'draft' || preview.approved) throw Error('unnecessary-review');
    preview.reviewed = true;
  } else if (data.action === 'approve') {
    if (!preview.reviewed || preview.approved) throw Error('unnecessary-approval');
    preview.state = 'approved'; preview.approved = true;
  } else if (data.action === 'publish') {
    if (!preview.approved || preview.state !== 'approved' || preview.screeningStatus === 'held')
      return Response.json({}, { status: 409 });
    if (${publishStatus} !== 200) return Response.json({}, { status: ${publishStatus} });
    preview.state = 'published'; preview.screeningStatus = 'published';
    preview.post = { id: 'synthetic-post', status: 'published' };
  } else throw Error('unexpected-action');
  return Response.json(preview);
};`,
    );
    let failed = false;
    try {
      execFileSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          "--import",
          pathToFileURL(shim).href,
          fileURLToPath(
            new URL("../../scripts/publish-editorial.ts", import.meta.url),
          ),
          "bundle.json",
          "review.json",
          command,
        ],
        { cwd: root, stdio: "pipe", timeout: 20_000 },
      );
    } catch {
      failed = true;
    }
    const receiptFile = readdirSync(directory).find((name) =>
      name.startsWith("publication-"),
    );
    expect(receiptFile).toBeTruthy();
    const receipt = JSON.parse(
      readFileSync(join(directory, receiptFile!), "utf8"),
    );
    const calls: Call[] = readFileSync(join(root, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return {
      failed,
      receipt,
      calls,
      actions: calls.map((c) => c.data?.action),
    };
  } finally {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw new Error("unexpected-test-directory");
    rmSync(root, { recursive: true, force: true });
  }
}

it.each([
  { bundle: { qualityPolicyVersion: undefined } },
  { bundle: { qualityPolicyVersion: "old-policy" } },
  { bundle: { qualityPolicyVersion: "reusable-technical-knowledge-v2" } },
  { verdict: { qualityPolicyVersion: undefined } },
  { verdict: { qualityPolicyVersion: "old-policy" } },
  { verdict: { qualityPolicyVersion: "reusable-technical-knowledge-v2" } },
  { verdict: { quality: undefined } },
  { verdict: { quality: false } },
  { verdict: { publicHash: "different-snapshot" } },
  { verdict: { meaning: undefined } },
  { verdict: { privacy: false } },
  { verdict: { rights: false } },
  { verdict: { externalTransfer: false } },
  { entry: { needsContext: true } },
  { entry: { needsContext: undefined } },
])(
  "holds invalid quality approval %j before accessing the candidate",
  (overrides) => {
    const result = run({}, "publish", 200, overrides);
    expect(result.failed).toBe(false);
    expect(result.actions).toEqual(["basis"]);
    expect(result.receipt).toMatchObject({
      ingested: 0,
      published: 0,
      held: 1,
    });
  },
);

it.each(["pending", "uncertain", null])(
  "retries an unchanged approved %s snapshot without revision, review, or approval",
  (screeningStatus) => {
    const result = run({ screeningStatus });
    expect(result.failed).toBe(false);
    expect(result.actions).toEqual(["basis", undefined, "publish", "snapshot"]);
    expect(result.calls[2].data).toEqual({
      action: "publish",
      revision: 7,
      hash: publicHash,
      ...versions,
    });
    expect(result.receipt).toMatchObject({ published: 1, held: 0, errors: 0 });
  },
);

it("reuses an unchanged published snapshot without publishing again", () => {
  const result = run({
    state: "published",
    screeningStatus: "published",
    post: { id: "synthetic-post", status: "published" },
  });
  expect(result.failed).toBe(false);
  expect(result.actions).toEqual(["basis", undefined, "snapshot"]);
  expect(result.receipt).toMatchObject({ published: 1, held: 0, errors: 0 });
});

it.each(["publish", "ingest"])(
  "counts a matching confirmed rejection as held during %s without writes to the draft",
  (command) => {
    const result = run({ screeningStatus: "held" }, command);
    expect(result.failed).toBe(false);
    expect(result.actions).toEqual(["basis", undefined]);
    expect(result.receipt).toMatchObject({
      ingested: 0,
      published: 0,
      held: 1,
      errors: 0,
      receipts: [{ state: "approved", screeningStatus: "held", post: null }],
    });
  },
);

it.each([
  { hash: "synthetic-old-hash" },
  { basisVersion: "synthetic-old-basis" },
  { rightsVersion: "synthetic-old-rights" },
  { rulesVersion: "synthetic-old-rules" },
])(
  "requires revision, review, approval and publish for changed %j",
  (change) => {
    const result = run({ screeningStatus: "held", ...change });
    expect(result.failed).toBe(false);
    expect(result.actions).toEqual([
      "basis",
      undefined,
      "revise",
      "review",
      "approve",
      "publish",
      "snapshot",
    ]);
    expect(result.calls[3].data).toMatchObject({
      revision: 8,
      hash: publicHash,
      ...versions,
      review: {
        model: "sol",
        effort: "xhigh",
        referenceId: "synthetic-review",
        compared: true,
        checks: {
          meaning: true,
          privacy: true,
          rights: true,
          externalTransfer: true,
        },
      },
    });
    expect(result.receipt).toMatchObject({ published: 1, held: 0, errors: 0 });
  },
);

it("restores a staff quality hold only through a fresh reviewed revision", () => {
  const result = run({
    state: "held",
    screeningStatus: null,
    post: { id: "synthetic-post", status: "held" },
  });
  expect(result.failed).toBe(false);
  expect(result.actions).toEqual([
    "basis",
    undefined,
    "revise",
    "review",
    "approve",
    "publish",
    "snapshot",
  ]);
  expect(result.calls[2].data).toMatchObject({
    action: "revise",
    revision: 7,
    draft: { revision: 8 },
  });
  expect(result.receipt).toMatchObject({ published: 1, held: 0, errors: 0 });
});

it("reports the server retry limit conflict without resetting approval or attempts", () => {
  const result = run({ screeningStatus: "uncertain" }, "publish", 409);
  expect(result.failed).toBe(true);
  expect(result.actions).toEqual(["basis", undefined, "publish"]);
  expect(result.receipt).toMatchObject({
    published: 0,
    errors: 1,
    receipts: [{ error: "editorial-http-409" }],
  });
});
