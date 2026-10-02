import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const context = vi.hoisted(() => ({ headers: new Headers() }));
const mail = vi.hoisted(() => ({ links: [] as string[] }));
vi.mock("@/server/auth-mail", () => ({
  mailConfigured: () => true,
  googleConfigured: () => false,
  sendAuthMail: async (_email: string, url: string) => {
    mail.links.push(url);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => context.headers }));
vi.mock("@/server/jev", () => ({
  screenPost: async () => ({ status: "published", evidence: "synthetic" }),
}));
vi.mock("@/server/duplicates/index", () => ({
  assessDuplicate: async () => ({
    verdict: "distinct",
    relatedPostIds: [],
    evidence: "synthetic",
    corpusHash: "synthetic",
  }),
  recordPublishedRelations: () => {},
  publicCorpusHash: () => "synthetic",
}));
let db: (typeof import("@/server/db"))["db"];
let auth: typeof import("@/server/auth");
let curation: typeof import("@/server/resource-curation");
let route: typeof import("@/app/api/resources/curation/route");
let resources: typeof import("@/server/resources");
let editorial: typeof import("@/server/editorial");
let editorCookie: string,
  memberCookie: string,
  editorId: string,
  memberId: string;
const versions = {
  basisVersion: "basis-1",
  rightsVersion: "rights-1",
  rulesVersion: "rules-1",
};
const checks = {
  meaning: true,
  privacy: true,
  rights: true,
  externalTransfer: true,
};
function request(
  body: unknown,
  origin = "http://localhost:3000",
  site?: string,
) {
  return new Request("http://localhost:3000/api/resources/curation", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(site ? { "sec-fetch-site": site } : {}),
    },
    body: JSON.stringify(body),
  });
}
async function snapshot(id = "member-post") {
  return curation.resourceCurationAction({ action: "snapshot", postId: id });
}
async function select(id = "member-post", guides?: string[]) {
  const current = await snapshot(id);
  return curation.resourceCurationAction({
    action: "select",
    postId: id,
    hash: current.hash,
    version: current.version,
    ...(guides ? { guides } : {}),
  });
}
beforeAll(async () => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.BETTER_AUTH_SECRET =
    "test-only-curation-session-secret-0123456789";
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  auth = await import("@/server/auth");
  ({ db } = await import("@/server/db"));
  const { getMigrations } = await import("better-auth/db/migration");
  await (await getMigrations(auth.auth.options)).runMigrations();
  async function signup(email: string) {
    const response = await auth.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          name: "Synthetic member",
          email,
          password: "test-password-123456",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const link = mail.links.pop();
    if (link) {
      const verified = await auth.auth.handler(new Request(link));
      expect([200, 302]).toContain(verified.status);
    }
    const login = await auth.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ email, password: "test-password-123456" }),
      }),
    );
    expect(login.status).toBe(200);
    return login.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
  }
  editorCookie = await signup("curator@example.test");
  memberCookie = await signup("member@example.test");
  context.headers = new Headers({ cookie: editorCookie });
  editorId = (await auth.getViewer())!.id;
  context.headers = new Headers({ cookie: memberCookie });
  memberId = (await auth.getViewer())!.id;
  curation = await import("@/server/resource-curation");
  route = await import("@/app/api/resources/curation/route");
  resources = await import("@/server/resources");
  editorial = await import("@/server/editorial");
  (await import("@/server/publication-control")).initPublicationTables();
  curation.currentResourceSelection();
});
beforeEach(() => {
  db.exec(`DELETE FROM resource_curation; DELETE FROM editorial_audit; DELETE FROM editorial_publications;
    DELETE FROM editorial_receipts; DELETE FROM editorial_sources; DELETE FROM editorial_revisions;
    DELETE FROM editorial_drafts; DELETE FROM editorial_suppression; DELETE FROM editorial_basis;
    DELETE FROM comments; DELETE FROM posts;
    DELETE FROM publication_limits; DELETE FROM publication_attempts; DELETE FROM publication_lease;`);
  context.headers = new Headers({ cookie: editorCookie });
  process.env.EDITOR_USER_ID = editorId;
  process.env.EDITORIAL_AUTHOR_USER_ID = memberId;
  db.prepare(
    "INSERT INTO posts(id,author_id,author_name,title,body,kind,tags,status,created_at) VALUES(?,?,?,?,?,?,?,'published',?)",
  ).run(
    "member-post",
    memberId,
    "Synthetic member",
    "Ghidra 학습",
    "Synthetic public body",
    "discussion",
    '["학습"]',
    "2026-10-02T00:00:00Z",
  );
});
afterAll(() => db?.close());

it.each(["new-public", "reused-public", "held", "reused-held", "stale"])(
  "publishing script curates only confirmed public snapshots: %s",
  (scenario) => {
    const directory = mkdtempSync(
      resolve(tmpdir(), "resource-curation-script-"),
    );
    const digest = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const publicData = {
      title: "Ghidra 학습",
      body: "Synthetic guide body",
      kind: "share",
      tags: ["학습"],
      provenance: {
        type: "independent-guide",
        period: "2026-10",
        verificationSummary: "Synthetic",
      },
    };
    const bundle = {
      ...versions,
      qualityPolicyVersion: "reusable-technical-knowledge-v2",
      processingRecord: "processing.json",
      entries: [
        {
          candidateKey: "synthetic",
          needsContext: false,
          sourceAliases: [],
          publicData,
          evidenceIds: ["synthetic"],
          reviewId: "synthetic",
        },
      ],
    };
    const draft = {
      ...versions,
      hash: digest(publicData),
      revision: 1,
      state: "draft",
      post: null,
    };
    const publicResult = {
      ...draft,
      state: "published",
      post: { id: "public-id", status: "published" },
    };
    try {
      mkdirSync(resolve(directory, "data/chat-pipeline"), { recursive: true });
      writeFileSync(
        resolve(directory, "data/chat-pipeline/editorial-session.json"),
        JSON.stringify({
          origin: "http://localhost:3000",
          cookie: "synthetic-session",
        }),
      );
      writeFileSync(resolve(directory, "bundle.json"), JSON.stringify(bundle));
      writeFileSync(
        resolve(directory, "review.json"),
        JSON.stringify({
          model: "gpt-6.1-sol",
          effort: "xhigh",
          entries: [
            {
              candidateKey: "synthetic",
              publicHash: draft.hash,
              passed: true,
              quality: true,
              qualityPolicyVersion: "reusable-technical-knowledge-v2",
              meaning: true,
              privacy: true,
              rights: true,
              externalTransfer: true,
              referenceId: "synthetic",
            },
          ],
        }),
      );
      writeFileSync(
        resolve(directory, "processing.json"),
        JSON.stringify({
          scope: "independently-written-nonpersonal-technical-material",
          ...versions,
          permitted: true,
        }),
      );
      const shim = resolve(directory, "mock-fetch.mjs");
      writeFileSync(
        shim,
        `
      import { appendFileSync } from 'node:fs';
      const scenario = ${JSON.stringify(scenario)};
      const draft = ${JSON.stringify(draft)};
      const published = ${JSON.stringify(publicResult)};
      globalThis.fetch = async (url, options = {}) => {
        if (options.headers.Cookie !== 'synthetic-session') throw Error('missing-session');
        const data = options.body ? JSON.parse(options.body) : null;
        if (data && options.headers.Origin !== 'http://localhost:3000') throw Error('missing-origin');
        appendFileSync('calls.jsonl', JSON.stringify({ url, data }) + '\\n');
        let result = draft;
        if (!data) {
          if (scenario === 'reused-public') result = published;
          else if (scenario === 'reused-held') result = { ...published, post: { id: 'public-id', status: 'held' } };
          else return Response.json({}, { status: 404 });
        } else if (data.action === 'publish') {
          result = ['held', 'reused-held'].includes(scenario) ? { ...draft, state: 'approved', post: { id: 'public-id', status: 'held' } } : published;
        } else if (data.action === 'snapshot') {
          result = { hash: 'actual-public-hash', version: 'actual-public-version', eligibleGuides: ['learning'], editorial: { ...published, hash: scenario === 'stale' ? 'changed' : published.hash } };
        } else if (data.action === 'select') {
          if (data.hash !== 'actual-public-hash' || data.version !== 'actual-public-version') throw Error('wrong-snapshot');
          result = { curated: true, guides: ['learning'] };
        }
        return Response.json(result);
      };
    `,
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
            "publish",
          ],
          { cwd: directory, stdio: "pipe", timeout: 20_000 },
        );
      } catch {
        failed = true;
      }
      const receiptFile = readdirSync(
        resolve(directory, "data/chat-pipeline"),
      ).find((file) => file.startsWith("publication-"))!;
      expect(receiptFile).toBeTruthy();
      const result = JSON.parse(
        readFileSync(
          resolve(directory, "data/chat-pipeline", receiptFile),
          "utf8",
        ),
      );
      const calls = readFileSync(resolve(directory, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const selections = calls.filter((call) => call.data?.action === "select");
      if (scenario.endsWith("public")) {
        expect(failed).toBe(false);
        expect(result).toMatchObject({ published: 1, errors: 0 });
        expect(selections).toHaveLength(1);
        expect(result.receipts[0].guides).toEqual(["learning"]);
        if (scenario === "reused-public")
          expect(calls.some((call) => call.data?.action === "publish")).toBe(
            false,
          );
      } else {
        expect(selections).toEqual([]);
        expect(result.published).toBe(0);
        expect(failed).toBe(scenario === "stale");
        expect(result).toMatchObject(
          scenario === "stale" ? { errors: 1 } : { held: 1 },
        );
      }
    } finally {
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
        throw new Error("unexpected-test-directory");
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("requires a real editor session and same-origin requests", async () => {
  const input = { action: "snapshot", postId: "member-post" };
  context.headers = new Headers();
  expect((await route.POST(request(input))).status).toBe(401);
  context.headers = new Headers({ cookie: "better-auth.session_token=forged" });
  expect((await route.POST(request(input))).status).toBe(401);
  context.headers = new Headers({ cookie: memberCookie });
  expect((await route.POST(request(input))).status).toBe(403);
  context.headers = new Headers({ cookie: editorCookie });
  expect((await route.POST(request(input, "https://other.test"))).status).toBe(
    403,
  );
  expect(
    (await route.POST(request(input, "http://localhost:3000", "cross-site")))
      .status,
  ).toBe(403);
  delete process.env.EDITOR_USER_ID;
  expect((await route.POST(request(input))).status).toBe(403);
  expect(db.prepare("SELECT * FROM resource_curation").all()).toEqual([]);
});

it("persists only the exact public snapshot and optional eligible guides", async () => {
  expect(curation.currentResourceSelection().has("member-post")).toBe(false);
  const current = await snapshot();
  const response = await route.POST(
    request({
      action: "select",
      postId: "member-post",
      hash: current.hash,
      version: current.version,
      guides: ["executables"],
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(curation.currentResourceSelection().get("member-post")).toEqual([
    "executables",
  ]);
  expect(await select("member-post", ["learning"])).toMatchObject({
    curated: true,
  });
  expect(db.prepare("SELECT actor_id FROM resource_curation").get()).toEqual({
    actor_id: editorId,
  });
  await expect(select("member-post", ["devices"])).rejects.toMatchObject({
    status: 400,
  });
  await expect(
    curation.resourceCurationAction({
      action: "select",
      postId: "member-post",
      hash: "wrong",
      version: current.version,
    }),
  ).rejects.toMatchObject({ status: 409 });
  db.prepare(
    "UPDATE posts SET body='Changed public body' WHERE id='member-post'",
  ).run();
  expect(curation.currentResourceSelection().has("member-post")).toBe(false);
  await expect(
    curation.resourceCurationAction({
      action: "select",
      postId: "member-post",
      hash: current.hash,
      version: current.version,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await select();
  expect(curation.currentResourceSelection().has("member-post")).toBe(true);
});

it.each(["held", "pending"])(
  "excludes %s posts even after selection and reveals no snapshot",
  async (status) => {
    await select();
    db.prepare("UPDATE posts SET status=? WHERE id='member-post'").run(status);
    expect(curation.currentResourceSelection().has("member-post")).toBe(false);
    const response = await route.POST(
      request({ action: "snapshot", postId: "member-post" }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty("hash");
  },
);

it("uses equal member/editorial eligibility and invalidates version changes and real withdrawal", async () => {
  await editorial.editorialCollectionAction({
    action: "basis",
    ...versions,
    allowed: true,
  });
  let draft = (await editorial.editorialCollectionAction({
    action: "ingest",
    candidateKey: "curation-editorial",
    revision: 1,
    sourceAliases: ["synthetic"],
    ...versions,
    publicData: {
      title: "Ghidra 학습",
      body: "A synthetic complete public guide for curation.",
      kind: "share",
      tags: ["학습"],
      provenance: {
        type: "independent-guide",
        period: "2026-10",
        verificationSummary: "Synthetic verification",
      },
    },
    privateEvidence: { referenceIds: ["synthetic-review"], checks },
  })) as Awaited<ReturnType<typeof editorial.getEditorial>>;
  const target = () => ({
    revision: draft.revision,
    hash: draft.hash,
    ...versions,
  });
  draft = await editorial.editorialAction("curation-editorial", {
    action: "review",
    ...target(),
    review: {
      model: "sol",
      effort: "xhigh",
      referenceId: "synthetic-review",
      compared: true,
      checks,
    },
  });
  draft = await editorial.editorialAction("curation-editorial", {
    action: "approve",
    ...target(),
  });
  draft = await editorial.editorialAction("curation-editorial", {
    action: "publish",
    ...target(),
  });
  expect(draft.post?.status).toBe("published");
  const id = draft.post!.id;
  expect((await snapshot(id)).eligibleGuides).toEqual(
    (await snapshot()).eligibleGuides,
  );
  await select(id);
  await select();
  const guides = resources.resourceGuides(
    resources.listResourcePosts(),
    curation.currentResourceSelection(),
  );
  expect(guides.map((guide) => guide.count)).toEqual([2, 2]);
  const original = db.prepare("SELECT body FROM posts WHERE id=?").get(id) as {
    body: string;
  };
  db.prepare(
    "UPDATE posts SET body='Different from the approved receipt' WHERE id=?",
  ).run(id);
  expect(curation.currentResourceSelection().has(id)).toBe(false);
  await expect(snapshot(id)).rejects.toMatchObject({ status: 409 });
  db.prepare("UPDATE posts SET body=? WHERE id=?").run(original.body, id);
  const current = await snapshot(id);
  db.prepare(
    "UPDATE editorial_publications SET versions=? WHERE candidate_key='curation-editorial'",
  ).run(JSON.stringify({ ...versions, rulesVersion: "rules-2" }));
  expect(curation.currentResourceSelection().has(id)).toBe(false);
  await expect(
    curation.resourceCurationAction({
      action: "select",
      postId: id,
      hash: current.hash,
      version: current.version,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await select(id);
  await editorial.editorialAction("curation-editorial", {
    action: "withdraw",
    ...target(),
  });
  expect(curation.currentResourceSelection().has(id)).toBe(false);
  expect(curation.currentResourceSelection().has("member-post")).toBe(true);
  await expect(snapshot(id)).rejects.toMatchObject({ status: 404 });
});
