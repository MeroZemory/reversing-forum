import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const context = vi.hoisted(() => ({ headers: new Headers() }));
const mail = vi.hoisted(() => ({ links: [] as string[] }));
vi.mock("@/server/auth-mail", () => ({
  mailConfigured: () => true,
  googleConfigured: () => false,
  sendAuthMail: async (_email: string, url: string) => {
    mail.links.push(url);
    return true;
  },
}));
const screening = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => context.headers }));
vi.mock("@/server/jev", () => ({ screenPost: screening.run }));
const duplicate = vi.hoisted(() => ({ run: vi.fn(), relations: vi.fn() }));
vi.mock("@/server/duplicates/index", () => ({
  assessDuplicate: duplicate.run,
  recordPublishedRelations: duplicate.relations,
  publicCorpusHash: () => "synthetic-corpus",
}));
let api: typeof import("@/server/editorial");
let db: (typeof import("@/server/db"))["db"];
let forum: typeof import("@/server/forum");
let collection: typeof import("@/app/api/editorial/route");
let item: typeof import("@/app/api/editorial/[id]/route");
let editorCookie: string;
let memberCookie: string;
let editorId: string;
let authorId: string;
const tuple = {
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
const review = {
  model: "sol",
  effort: "xhigh",
  referenceId: "review-1",
  compared: true,
  checks,
};
const input = (key = "candidate-1", revision = 1) => ({
  candidateKey: key,
  revision,
  sourceAliases: ["source-1"],
  ...tuple,
  publicData: {
    title: "합성 편집 자료",
    body: "합성 문답을 확인해 정리한 충분한 설명입니다.",
    kind: "share",
    tags: ["assembly"],
    provenance: {
      type: "chat-editorial",
      period: "2026-10",
      verificationSummary: "합성 자료 대조 완료",
    },
  },
  privateEvidence: { referenceIds: ["private-evidence-1"], checks },
});
type Preview = Awaited<ReturnType<typeof api.getEditorial>>;
const target = (d: Preview) => ({
  revision: d.revision,
  hash: d.hash,
  basisVersion: d.basisVersion,
  rightsVersion: d.rightsVersion,
  rulesVersion: d.rulesVersion,
});
const action = (d: Preview, name: string, extra = {}) =>
  api.editorialAction(d.candidateKey, { action: name, ...target(d), ...extra });
async function ingest(key = "candidate-1") {
  return (await api.editorialCollectionAction({
    action: "ingest",
    ...input(key),
  })) as Preview;
}
async function approved(key = "candidate-1") {
  let d = await ingest(key);
  d = await action(d, "review", { review });
  return action(d, "approve");
}
function request(body: unknown, origin = "http://localhost:3000") {
  return new Request("http://localhost:3000/api/editorial", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}
function deferred() {
  let resolve!: (v: { status: string; evidence: string }) => void;
  const promise = new Promise<{ status: string; evidence: string }>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeAll(async () => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.BETTER_AUTH_SECRET =
    "test-only-editorial-session-secret-0123456789";
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  const authModule = await import("@/server/auth");
  ({ db } = await import("@/server/db"));
  const { getMigrations } = await import("better-auth/db/migration");
  await (await getMigrations(authModule.auth.options)).runMigrations();
  async function signup(email: string) {
    const response = await authModule.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          name: "테스트 회원",
          email,
          password: "test-password-123456",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const verified = await authModule.auth.handler(
      new Request(mail.links.at(-1)!),
    );
    expect(verified.status).toBeLessThan(400);
    const login = await authModule.auth.handler(
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
      .map((c) => c.split(";")[0])
      .join("; ");
  }
  editorCookie = await signup("editor@example.test");
  memberCookie = await signup("member@example.test");
  context.headers = new Headers({ cookie: memberCookie });
  authorId = (await authModule.getViewer())!.id;
  context.headers = new Headers({ cookie: editorCookie });
  editorId = (await authModule.getViewer())!.id;
  api = await import("@/server/editorial");
  (await import("@/server/publication-control")).initPublicationTables();
  forum = await import("@/server/forum");
  collection = await import("@/app/api/editorial/route");
  item = await import("@/app/api/editorial/[id]/route");
});
beforeEach(async () => {
  db.exec(`DELETE FROM editorial_audit; DELETE FROM editorial_publications; DELETE FROM editorial_receipts;
    DELETE FROM editorial_sources; DELETE FROM editorial_revisions; DELETE FROM editorial_drafts;
    DELETE FROM editorial_suppression; DELETE FROM editorial_basis; DELETE FROM comments; DELETE FROM posts;`);
  db.exec(
    "DELETE FROM publication_limits; DELETE FROM publication_attempts; DELETE FROM publication_lease;",
  );
  duplicate.relations.mockReset().mockImplementation(() => {
    expect(db.inTransaction).toBe(true);
  });
  duplicate.run.mockReset().mockResolvedValue({
    verdict: "distinct",
    relatedPostIds: [],
    evidence: "synthetic-duplicate-evidence",
    corpusHash: "synthetic-corpus",
  });
  context.headers = new Headers({ cookie: editorCookie });
  process.env.EDITOR_USER_ID = editorId;
  process.env.EDITORIAL_AUTHOR_USER_ID = authorId;
  screening.run.mockReset().mockResolvedValue({
    status: "published",
    evidence: "private-jev-evidence",
  });
  await api.editorialCollectionAction({
    action: "basis",
    ...tuple,
    allowed: true,
  });
});

it("shares the paid-call lease with normal posts and keeps editorial gates intact", async () => {
  const draft = await approved();
  const waiting = deferred();
  screening.run.mockReturnValueOnce(waiting.promise);
  const normal = forum.createPost(
    { id: authorId, name: "synthetic author", email: "synthetic@example.test" },
    {
      title: "Synthetic normal post",
      body: "A complete synthetic normal post for concurrency.",
      kind: "question",
      tags: [],
    },
  );
  await vi.waitFor(() => expect(screening.run).toHaveBeenCalledTimes(1));
  const blocked = await action(draft, "publish");
  expect(blocked.post).toBeNull();
  expect(blocked.screeningStatus).toBe("pending");
  expect(screening.run).toHaveBeenCalledTimes(1);
  waiting.resolve({ status: "published", evidence: "synthetic pass" });
  expect((await normal).status).toBe("published");
  expect((await action(draft, "publish")).post?.status).toBe("published");
});

it("does not let a request select or override the authenticated publication lane", async () => {
  const draft = await approved();
  await expect(
    action(draft, "publish", { lane: "editorial" }),
  ).rejects.toMatchObject({ status: 400 });
  expect(screening.run).not.toHaveBeenCalled();
});

it("persists assessed editorial relations separately from private screening evidence", async () => {
  db.prepare(
    "INSERT INTO posts(id,author_id,author_name,title,body,kind,tags,status,created_at) VALUES('relation-target','synthetic','synthetic','title','body','analysis','[]','published','old')",
  ).run();
  duplicate.run.mockResolvedValueOnce({
    verdict: "related",
    relatedPostIds: ["relation-target"],
    evidence: "private comparison",
    corpusHash: "synthetic-corpus",
  });
  const published = await action(await approved(), "publish");
  expect(duplicate.relations).toHaveBeenCalledWith(
    published.post!.id,
    ["relation-target"],
    "synthetic-corpus",
  );
  expect(
    db
      .prepare("SELECT screening_evidence FROM posts WHERE id=?")
      .get(published.post!.id),
  ).toEqual({ screening_evidence: null });
  expect(JSON.stringify(published)).not.toContain("private comparison");
});

it("keeps duplicate evidence private and a revision excludes only its own receipt", async () => {
  const a = await approved();
  duplicate.run.mockResolvedValueOnce({
    verdict: "duplicate",
    relatedPostIds: ["missing-private-id"],
    evidence: "private duplicate evidence",
    corpusHash: "synthetic-corpus",
  });
  const held = await action(a, "publish");
  expect(held.screeningStatus).toBe("held");
  expect(held.post).toBeNull();
  expect(JSON.stringify(held)).not.toContain("private duplicate evidence");
  expect(screening.run).not.toHaveBeenCalled();
  const state = db
    .prepare("SELECT state FROM editorial_drafts WHERE candidate_key=?")
    .get(a.candidateKey) as { state: string };
  expect(JSON.parse(state.state).screening.evidence).toContain(
    "private duplicate evidence",
  );

  const first = await action(await approved("other-candidate"), "publish");
  const changed = input("other-candidate", 2);
  changed.publicData.body += " A synthetic new contribution.";
  let revision = await action(first, "revise", { draft: changed });
  revision = await action(revision, "review", { review });
  revision = await action(revision, "approve");
  const updated = await action(revision, "publish");
  expect(updated.post?.id).toBe(first.post?.id);
  expect(duplicate.run.mock.calls.at(-1)?.[0].excludePostId).toBe(
    first.post?.id,
  );
});
afterAll(() => db.close());

describe("editorial server gates and privacy", () => {
  it("requires an existing dedicated author while reserving approval to the operator", async () => {
    delete process.env.EDITORIAL_AUTHOR_USER_ID;
    await expect(ingest()).rejects.toMatchObject({ status: 403 });
    process.env.EDITORIAL_AUTHOR_USER_ID = "missing-account";
    await expect(ingest()).rejects.toMatchObject({ status: 403 });
    process.env.EDITORIAL_AUTHOR_USER_ID = editorId;
    await expect(ingest()).rejects.toMatchObject({ status: 403 });
    process.env.EDITORIAL_AUTHOR_USER_ID = authorId;
    const d = await ingest();
    context.headers = new Headers({ cookie: memberCookie });
    await expect(action(d, "review", { review })).rejects.toMatchObject({
      status: 403,
    });
    // Changing the configured operator does not grant ownership of old drafts.
    process.env.EDITOR_USER_ID = authorId;
    await expect(api.getEditorial(d.candidateKey)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("uses real sessions and rejects anonymous, forged sessions and noneditor body roles", async () => {
    for (const cookie of [
      "",
      "better-auth.session_token=forged",
      memberCookie,
    ]) {
      context.headers = new Headers({ cookie });
      const response = await collection.POST(
        request({
          action: "ingest",
          ...input(),
          viewer: { id: editorId },
          role: "editor",
          approved: true,
        }),
      );
      expect(response.status).toBe(cookie === memberCookie ? 403 : 401);
    }
    context.headers = new Headers({ cookie: editorCookie });
    delete process.env.EDITOR_USER_ID;
    expect(
      (await collection.POST(request({ action: "ingest", ...input() }))).status,
    ).toBe(403);
    expect(screening.run).not.toHaveBeenCalled();
  });
  it("rejects forged gates, unknown fields and cross-site writes", async () => {
    expect(
      (
        await collection.POST(
          request({ action: "ingest", ...input(), approved: true }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await collection.POST(
          request({ action: "ingest", ...input() }, "https://other.example"),
        )
      ).status,
    ).toBe(403);
    const d = await ingest();
    await expect(
      action(d, "publish", { screeningStatus: "published" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      action(d, "review", { review: { ...review, approved: true } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(forum.listPosts()).toEqual([]);
  });
  it("keeps draft, review alone, and approval without passing Jev private", async () => {
    const d = await ingest();
    await expect(action(d, "approve")).rejects.toMatchObject({ status: 409 });
    await expect(action(d, "publish")).rejects.toMatchObject({ status: 409 });
    const r = await action(d, "review", { review });
    await expect(action(r, "publish")).rejects.toMatchObject({ status: 409 });
    const a = await action(r, "approve");
    screening.run.mockResolvedValueOnce({
      status: "held",
      evidence: "private",
    });
    expect((await action(a, "publish")).post).toBeNull();
    await expect(action(a, "publish")).rejects.toMatchObject({ status: 409 });
    expect(screening.run).toHaveBeenCalledTimes(1);
    expect(forum.listPosts()).toEqual([]);
  });
  it("bounds API errors to three attempts and never publishes them", async () => {
    const a = await approved();
    screening.run.mockRejectedValue(new Error("api failure"));
    for (let n = 0; n < 3; n++)
      expect((await action(a, "publish")).screeningStatus).toBe("pending");
    await expect(action(a, "publish")).rejects.toMatchObject({ status: 409 });
    expect(forum.listPosts()).toEqual([]);
  });
  it("checks limits, evidence structure, latest basis and review checks on the server", async () => {
    for (const patch of [
      { sourceAliases: ["raw source text"] },
      { publicData: { ...input().publicData, body: "x".repeat(30_001) } },
      { privateEvidence: { ...input().privateEvidence, raw: "source" } },
      { revision: 1.5 },
    ]) {
      await expect(
        api.editorialCollectionAction({
          action: "ingest",
          ...input(),
          ...patch,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    const d = await ingest();
    await expect(
      action(d, "review", {
        review: { ...review, checks: { ...checks, rights: false } },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await api.editorialCollectionAction({
      action: "basis",
      ...tuple,
      rightsVersion: "rights-2",
      allowed: true,
    });
    await expect(action(d, "review", { review })).rejects.toMatchObject({
      status: 409,
    });
  });
  it("accepts the bounded full ingest envelope through the HTTP byte limit", async () => {
    const draft = input();
    draft.publicData.body = "가".repeat(30_000);
    draft.publicData.title = "가".repeat(160);
    draft.publicData.provenance.period = "가".repeat(80);
    draft.publicData.provenance.verificationSummary = "가".repeat(1000);
    draft.publicData.tags = Array.from(
      { length: 5 },
      (_, i) => `${i}${"가".repeat(23)}`,
    );
    draft.sourceAliases = Array.from(
      { length: 100 },
      (_, i) => `s${String(i).padStart(3, "0")}${"a".repeat(124)}`,
    );
    draft.privateEvidence.referenceIds = Array.from(
      { length: 100 },
      (_, i) => `e${String(i).padStart(3, "0")}${"b".repeat(124)}`,
    );
    const body = { action: "ingest", ...draft };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(120_000);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(160_000);
    const response = await collection.POST(request(body));
    expect(response.status).toBe(200);
    expect((await response.json()).publicData.body).toBe(draft.publicData.body);
  });
  it("rejects same-key different payload and exposes no private evidence in preview or public queries", async () => {
    const d = await ingest();
    expect(await ingest()).toEqual(d);
    await expect(
      api.editorialCollectionAction({
        action: "ingest",
        ...input(),
        privateEvidence: {
          ...input().privateEvidence,
          referenceIds: ["different"],
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    const response = await item.GET(
      new Request("http://localhost:3000/api/editorial/candidate-1"),
      { params: Promise.resolve({ id: d.candidateKey }) },
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const preview = JSON.stringify(await response.json());
    for (const secret of [
      "private-evidence-1",
      "source-1",
      "privateEvidence",
      "referenceIds",
    ])
      expect(preview).not.toContain(secret);
    context.headers = new Headers({ cookie: memberCookie });
    expect(
      (
        await item.GET(new Request("http://localhost:3000"), {
          params: Promise.resolve({ id: d.candidateKey }),
        })
      ).status,
    ).toBe(403);
    context.headers = new Headers({ cookie: editorCookie });
    process.env.EDITOR_USER_ID = "other-editor";
    await expect(api.getEditorial(d.candidateKey)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("publication transactions and invalidation", () => {
  it("publishes exactly the complete public data and returns the same post after response loss", async () => {
    const a = await approved();
    const p = await action(a, "publish");
    expect(p.post?.status).toBe("published");
    await expect(action(p, "review", { review })).rejects.toMatchObject({
      status: 409,
    });
    expect(forum.getPost(p.post!.id)?.author.id).toBe(authorId);
    expect(forum.getPost(p.post!.id)?.kind).toBe("analysis");
    expect(
      forum.listPostPage({ purpose: "share" }).posts.map((post) => post.id),
    ).toEqual([p.post!.id]);
    expect(
      db
        .prepare("SELECT actor_id FROM editorial_audit WHERE action='approve'")
        .get(),
    ).toEqual({ actor_id: editorId });
    expect(JSON.parse(screening.run.mock.calls[0][0])).toEqual(
      input().publicData,
    );
    expect(await action(a, "publish")).toEqual(p);
    expect(screening.run).toHaveBeenCalledTimes(1);
    expect(forum.listPosts()).toHaveLength(1);
    expect(JSON.stringify(forum.getPost(p.post!.id))).not.toContain("private");
    const held = await action(p, "withdraw");
    expect((await action(a, "publish")).post).toEqual(held.post);
    expect((await action(held, "withdraw")).post?.status).toBe("held");
    await expect(
      action(a, "publish", { rightsVersion: "wrong" }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("does not duplicate rows on concurrent publishing", async () => {
    const a = await approved();
    const results = await Promise.all([
      action(a, "publish"),
      action(a, "publish"),
    ]);
    expect(results[0].post).toEqual(results[1].post);
    expect(results[0].post?.status).toBe("published");
    expect(screening.run).toHaveBeenCalledTimes(1);
    expect(forum.listPosts()).toHaveLength(1);
    expect(
      db.prepare("SELECT count(*) n FROM editorial_receipts").get(),
    ).toEqual({ n: 1 });
    expect((await action(a, "publish")).post?.id).toBe(forum.listPosts()[0].id);
  });
  it("invalidates changed final data and keeps the original post held during revision", async () => {
    const a = await approved();
    const p = await action(a, "publish");
    const revised = {
      ...input("candidate-1", 2),
      publicData: { ...input().publicData, title: "수정한 제목" },
    };
    const d = await action(p, "revise", { draft: revised });
    expect(d.hash).not.toBe(p.hash);
    expect(d.approved).toBe(false);
    expect(forum.getPost(p.post!.id)).toBeNull();
    await expect(action(d, "publish")).rejects.toMatchObject({ status: 409 });
    await expect(action(d, "approve", { hash: p.hash })).rejects.toMatchObject({
      status: 409,
    });
    expect(await action(p, "revise", { draft: revised })).toEqual(d);
    await expect(
      action(p, "revise", {
        draft: {
          ...revised,
          publicData: {
            ...revised.publicData,
            body: "다른 자료와 충분한 설명입니다.",
          },
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    const r = await action(d, "review", { review });
    const next = await action(await action(r, "approve"), "publish");
    expect(next.post?.id).toBe(p.post?.id);
    expect(forum.listPosts()).toHaveLength(1);
  });
  for (const change of ["withdraw", "revise", "basis", "review"] as const) {
    it(`rejects late Jev after ${change}`, async () => {
      const a = await approved();
      const waiting = deferred();
      screening.run.mockReturnValueOnce(waiting.promise);
      const publishing = action(a, "publish");
      const rejection = expect(publishing).rejects.toMatchObject({
        status: 409,
      });
      await vi.waitFor(() => expect(screening.run).toHaveBeenCalledTimes(1));
      if (change === "basis")
        await api.editorialCollectionAction({
          action: "basis",
          ...tuple,
          allowed: false,
        });
      else if (change === "revise")
        await action(a, "revise", { draft: input("candidate-1", 2) });
      else if (change === "review") {
        const r = await action(a, "review", { review });
        await action(r, "approve");
      } else await action(a, change);
      waiting.resolve({ status: "published", evidence: "late" });
      await rejection;
      expect(forum.listPosts()).toEqual([]);
    });
  }
  it("rechecks the actual operator session after screening", async () => {
    const a = await approved();
    const waiting = deferred();
    screening.run.mockReturnValueOnce(waiting.promise);
    const publishing = action(a, "publish");
    const rejection = expect(publishing).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(screening.run).toHaveBeenCalledTimes(1));
    context.headers = new Headers({
      cookie: "better-auth.session_token=forged",
    });
    waiting.resolve({ status: "published", evidence: "late" });
    await rejection;
    expect(forum.listPosts()).toEqual([]);
  });
  it("rolls back the entire withdrawal when a later write fails", async () => {
    const p = await action(await approved(), "publish");
    db.exec(
      "CREATE TRIGGER fail_withdraw BEFORE UPDATE OF status ON posts WHEN NEW.status='held' BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    try {
      await expect(action(p, "withdraw")).rejects.toThrow("injected");
    } finally {
      db.exec("DROP TRIGGER fail_withdraw");
    }
    expect(await api.getEditorial(p.candidateKey)).toEqual(p);
    expect(
      db.prepare("SELECT count(*) n FROM editorial_suppression").get(),
    ).toEqual({ n: 0 });
    expect(forum.getPost(p.post!.id)).not.toBeNull();
  });
  it("atomically rolls back a post insertion if receipt writing fails", async () => {
    const a = await approved();
    db.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON editorial_receipts BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    try {
      await expect(action(a, "publish")).rejects.toThrow("injected");
    } finally {
      db.exec("DROP TRIGGER fail_receipt");
    }
    expect(forum.listPosts()).toEqual([]);
    expect(db.prepare("SELECT count(*) n FROM posts").get()).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT count(*) n FROM editorial_publications").get(),
    ).toEqual({ n: 0 });
    expect((await action(a, "publish")).post?.status).toBe("published");
  });
  it("propagates alias suppression and requires explicit staff review for a new candidate", async () => {
    const p = await action(await approved(), "publish");
    const second = await approved("candidate-2");
    await action(p, "withdraw");
    expect((await api.getEditorial(second.candidateKey)).approved).toBe(false);
    await expect(action(second, "publish")).rejects.toMatchObject({
      status: 409,
    });
    const fresh = await ingest("candidate-3");
    await expect(action(fresh, "publish")).rejects.toMatchObject({
      status: 409,
    });
    await expect(action(fresh, "approve")).rejects.toMatchObject({
      status: 409,
    });
    const reviewed = await action(fresh, "review", { review });
    expect(
      (await action(await action(reviewed, "approve"), "publish")).post?.status,
    ).toBe("published");
    expect((await api.getEditorial(p.candidateKey)).post?.status).toBe("held");
  });
  it("basis changes hold published posts and restoring a tuple does not restore approval", async () => {
    const p = await action(await approved(), "publish");
    await api.editorialCollectionAction({
      action: "basis",
      ...tuple,
      allowed: false,
    });
    expect(forum.listPosts()).toEqual([]);
    expect(forum.listPostPage().total).toBe(0);
    expect(forum.listPublicTopics()).toEqual([]);
    expect(forum.getPost(p.post!.id)).toBeNull();
    expect(forum.getPost(p.post!.id, authorId)?.status).toBe("held");
    expect(forum.getPost(p.post!.id, editorId)).toBeNull();
    expect(forum.listComments(p.post!.id)).toEqual([]);
    await expect(
      Promise.resolve().then(() =>
        forum.createComment(
          { id: editorId, name: "회원", email: "editor@example.test" },
          p.post!.id,
          { body: "댓글" },
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await api.editorialCollectionAction({
      action: "basis",
      ...tuple,
      allowed: true,
    });
    const held = await api.getEditorial(p.candidateKey);
    expect(held.approved).toBe(false);
    await expect(action(held, "approve")).rejects.toMatchObject({
      status: 409,
    });
    expect((await action(p, "publish")).post?.status).toBe("held");
    expect(
      JSON.stringify(db.prepare("SELECT * FROM editorial_audit").all()),
    ).not.toContain(input().publicData.body);
  });
});
