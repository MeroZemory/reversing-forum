import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Viewer, PostStatus } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  duplicate: vi.fn(),
  jev: vi.fn(),
  relations: vi.fn(),
}));
const context = vi.hoisted(() => ({
  headers: new Headers(),
  mail: [] as string[],
}));
vi.mock("next/headers", () => ({ headers: async () => context.headers }));
vi.mock("@/server/auth-mail", () => ({
  mailConfigured: () => true,
  googleConfigured: () => false,
  sendAuthMail: async (_email: string, url: string) => {
    context.mail.push(url);
    return true;
  },
}));
vi.mock("@/server/duplicates/index", () => ({
  assessDuplicate: mocks.duplicate,
  publicCorpusHash: () => "synthetic-corpus",
  recordPublishedRelations: mocks.relations,
}));
vi.mock("@/server/jev", () => ({ screenPost: mocks.jev }));

let forum: typeof import("@/server/forum");
let db: (typeof import("@/server/db"))["db"];
let publication: typeof import("@/server/publication-control");
let authModule: typeof import("@/server/auth");
const owner: Viewer = {
  id: "owner",
  name: "작성자",
  email: "owner@example.test",
  emailVerified: true,
  nicknameReady: true,
};
const original = {
  title: "합성 분석 질문",
  body: "합성 분석의 기존 본문과 재현 조건입니다.",
  kind: "analysis",
  tags: ["test"],
};
const revised = {
  ...original,
  body: "합성 분석에 새 재현 조건과 검증 결과를 추가합니다.",
};
const assessment = {
  verdict: "distinct",
  relatedPostIds: [],
  evidence: "synthetic",
  corpusHash: "synthetic-corpus",
};

beforeAll(async () => {
  process.env.DATABASE_PATH = ":memory:";
  delete process.env.AUTH_CONFIG_FILE;
  process.env.BETTER_AUTH_SECRET =
    "test-only-secret-for-isolated-memory-db-0123456789";
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  authModule = await import("@/server/auth");
  ({ db } = await import("@/server/db"));
  const { getMigrations } = await import("better-auth/db/migration");
  await (await getMigrations(authModule.auth.options)).runMigrations();
  forum = await import("@/server/forum");
  publication = await import("@/server/publication-control");
  publication.initPublicationTables();
});
beforeEach(() => {
  db.exec(
    "DELETE FROM editorial_receipts; DELETE FROM editorial_drafts; DELETE FROM comments; DELETE FROM posts; DELETE FROM publication_attempts; DELETE FROM publication_limits; DELETE FROM publication_lease;",
  );
  delete process.env.EDITORIAL_AUTHOR_USER_ID;
  context.headers = new Headers();
  mocks.duplicate.mockReset().mockResolvedValue(assessment);
  mocks.jev
    .mockReset()
    .mockResolvedValue({ status: "published", evidence: "synthetic Jev" });
  mocks.relations
    .mockReset()
    .mockImplementation(() => expect(db.inTransaction).toBe(true));
});
afterAll(() => db.close());

function seed(
  id = "post",
  status: PostStatus = "published",
  user = owner,
  payload = original,
) {
  db.prepare(
    "INSERT INTO posts(id,author_id,author_name,title,body,kind,tags,status,created_at,screening_evidence) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    user.id,
    user.name,
    payload.title,
    payload.body,
    payload.kind,
    JSON.stringify(payload.tags),
    status,
    "2026-01-01T00:00:00.000Z",
    "old private evidence",
  );
  db.prepare(
    "INSERT INTO post_payloads(author_id,payload_hash,body_hash,post_id) VALUES(?,?,?,?)",
  ).run(
    user.id,
    publication.payloadHash(payload),
    publication.payloadHash(payload.body),
    id,
  );
}
function edit(payload = revised, id = "post") {
  return {
    ...payload,
    expectedHash: forum.getEditablePost(owner, id).expectedHash,
  };
}
function counts() {
  return db
    .prepare("SELECT * FROM publication_attempts ORDER BY request_key")
    .all();
}

it.each([
  [null, 401],
  [{ ...owner, id: "other" }, 404],
  [{ ...owner, emailVerified: false }, 403],
  [{ ...owner, nicknameReady: false }, 403],
] as [Viewer | null, number][])(
  "rejects unauthorized read and save (%s)",
  async (viewer, status) => {
    seed();
    expect(() => forum.getEditablePost(viewer, "post")).toThrow();
    await expect(
      forum.updatePost(viewer, "post", {
        ...revised,
        expectedHash: publication.payloadHash(original),
      }),
    ).rejects.toMatchObject({ status });
    expect(forum.getPost("post")?.body).toBe(original.body);
    expect(mocks.duplicate).not.toHaveBeenCalled();
  },
);

it.each(["published", "held"] as const)(
  "rejects receipt-linked %s posts even under a normal author",
  async (status) => {
    seed("post", status);
    db.prepare(
      "INSERT INTO editorial_drafts VALUES('candidate',?,'editor','ready')",
    ).run(owner.id);
    db.prepare(
      "INSERT INTO editorial_receipts VALUES('candidate','post',1,'synthetic','{}')",
    ).run();
    await expect(
      forum.updatePost(owner, "post", {
        ...revised,
        expectedHash: publication.payloadHash(original),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(() => forum.getEditablePost(owner, "post")).toThrow();
    expect(counts()).toEqual([]);
  },
);

it("rejects designated editorial authors without a receipt", async () => {
  seed();
  process.env.EDITORIAL_AUTHOR_USER_ID = owner.id;
  await expect(
    forum.updatePost(owner, "post", {
      ...revised,
      expectedHash: publication.payloadHash(original),
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(mocks.jev).not.toHaveBeenCalled();
});

it("makes a saved edit private immediately and invalidates old evidence before screening", async () => {
  seed();
  let release!: (value: typeof assessment) => void;
  mocks.duplicate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const saving = forum.updatePost(owner, "post", edit());
  expect(forum.getPost("post")).toBeNull();
  expect(forum.getPost("post", "other")).toBeNull();
  expect(forum.listPosts()).toEqual([]);
  expect(forum.getPost("post", owner.id)).toMatchObject({
    body: revised.body,
    status: "pending",
  });
  expect(
    db.prepare("SELECT screening_evidence FROM posts WHERE id='post'").get(),
  ).toEqual({ screening_evidence: null });
  release(assessment);
  expect(await saving).toEqual({ id: "post", status: "published" });
  expect(mocks.duplicate.mock.calls[0][0].excludePostId).toBe("post");
  expect(JSON.parse(mocks.jev.mock.calls[0][0])).toEqual(revised);
  expect(forum.getPost("post")?.body).toBe(revised.body);
});

it("blocks an old in-flight screening result after a newer edit", async () => {
  seed("post", "pending");
  let release!: (value: { status: string; evidence: string }) => void;
  let entered!: () => void;
  const screening = new Promise<void>((resolve) => {
    entered = resolve;
  });
  mocks.jev.mockImplementationOnce(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const old = forum.retryPostPublication(owner, "post");
  const oldRejected = expect(old).rejects.toMatchObject({ status: 409 });
  await screening;
  expect(await forum.updatePost(owner, "post", edit())).toEqual({
    id: "post",
    status: "pending",
  });
  const before = db
    .prepare("SELECT screening_evidence FROM posts WHERE id='post'")
    .get();
  release({ status: "published", evidence: "old result" });
  await oldRejected;
  expect(forum.getPost("post")).toBeNull();
  expect(
    db.prepare("SELECT screening_evidence FROM posts WHERE id='post'").get(),
  ).toEqual(before);
  expect(mocks.relations).not.toHaveBeenCalled();
  expect((await forum.retryPostPublication(owner, "post")).status).toBe(
    "published",
  );
  expect(forum.getPost("post")?.body).toBe(revised.body);
});

it.each(["error", "held"])("keeps Jev %s private", async (mode) => {
  seed();
  if (mode === "error")
    mocks.jev.mockRejectedValueOnce(new Error("synthetic failure"));
  else
    mocks.jev.mockResolvedValueOnce({
      status: "held",
      evidence: "synthetic violation",
    });
  expect((await forum.updatePost(owner, "post", edit())).status).toBe(
    mode === "error" ? "pending" : "held",
  );
  expect(forum.getPost("post")).toBeNull();
  expect(forum.getPost("post", owner.id)?.body).toBe(revised.body);
});

it.each(["published", "pending", "held"] as const)(
  "saves unchanged %s content without gate or attempt costs",
  async (status) => {
    seed("post", status);
    const input = edit(original);
    expect(await forum.updatePost(owner, "post", input)).toEqual({
      id: "post",
      status,
    });
    expect(counts()).toEqual([]);
    expect(db.prepare("SELECT * FROM publication_limits").all()).toEqual([]);
    expect(mocks.duplicate).not.toHaveBeenCalled();
    expect(mocks.jev).not.toHaveBeenCalled();
    expect(db.prepare("SELECT screening_evidence FROM posts").get()).toEqual({
      screening_evidence: "old private evidence",
    });
  },
);

it("returns concurrent and later final-content retransmissions without extra costs", async () => {
  seed();
  const input = edit();
  const [first, concurrent] = await Promise.all([
    forum.updatePost(owner, "post", input),
    forum.updatePost(owner, "post", input),
  ]);
  expect(first.status).toBe("published");
  expect(concurrent.status).toBe("pending");
  const attempts = counts();
  const limits = db
    .prepare("SELECT * FROM publication_limits ORDER BY scope")
    .all();
  expect(await forum.updatePost(owner, "post", input)).toEqual(first);
  expect(counts()).toEqual(attempts);
  expect(
    db.prepare("SELECT * FROM publication_limits ORDER BY scope").all(),
  ).toEqual(limits);
  expect(mocks.duplicate).toHaveBeenCalledTimes(1);
  expect(mocks.jev).toHaveBeenCalledTimes(1);
});

it("returns 409 for stale different content and preserves history and old attempts", async () => {
  seed();
  const input = edit();
  db.prepare("INSERT INTO publication_attempts VALUES(?,2)").run(
    `post:post:${publication.payloadHash(original)}`,
  );
  await forum.updatePost(owner, "post", input);
  await expect(
    forum.updatePost(owner, "post", {
      ...input,
      body: "합성 분석의 서로 경쟁하는 다른 수정 내용입니다.",
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(forum.getPost("post")?.body).toBe(revised.body);
  expect(counts()).toContainEqual({
    request_key: `post:post:${publication.payloadHash(original)}`,
    attempts: 2,
  });
  expect(db.prepare("SELECT count(*) n FROM post_payloads").get()).toEqual({
    n: 2,
  });
  expect(mocks.jev).toHaveBeenCalledTimes(1);
});

it("allows a new title with the same post's historical body but blocks another post's body", async () => {
  seed();
  const metadata = {
    ...original,
    title: "수정한 분석 제목",
    tags: ["updated"],
  };
  expect((await forum.updatePost(owner, "post", edit(metadata))).status).toBe(
    "published",
  );
  await forum.updatePost(owner, "post", edit());
  seed("other-post", "held", owner, {
    ...original,
    body: "다른 자기 글의 중복을 위한 합성 본문입니다.",
  });
  const restored = { ...revised, title: "또 다른 제목", body: original.body };
  expect((await forum.updatePost(owner, "post", edit(restored))).status).toBe(
    "published",
  );
  expect(JSON.parse(mocks.jev.mock.calls[2][0])).toEqual(restored);
  await expect(
    forum.updatePost(
      owner,
      "post",
      edit({
        ...restored,
        body: "다른 자기 글의 중복을 위한 합성 본문입니다.",
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    db
      .prepare("SELECT count(*) n FROM post_payloads WHERE post_id='post'")
      .get(),
  ).toEqual({ n: 4 });
  expect(mocks.jev).toHaveBeenCalledTimes(3);
});

it("preserves legacy snapshot history when the initial post has no payload receipt", async () => {
  seed();
  db.exec("DELETE FROM post_payloads");
  await forum.updatePost(owner, "post", edit());
  expect(db.prepare("SELECT count(*) n FROM post_payloads").get()).toEqual({
    n: 2,
  });
  expect((await forum.updatePost(owner, "post", edit(original))).status).toBe(
    "published",
  );
  expect(db.prepare("SELECT count(*) n FROM post_payloads").get()).toEqual({
    n: 2,
  });
  expect(mocks.jev).toHaveBeenCalledTimes(2);
});

it("allows title A to B to A through screening while preserving receipts and blocking other posts' historical bodies", async () => {
  seed();
  const originalReceipt = db
    .prepare("SELECT * FROM post_payloads WHERE post_id='post'")
    .get();
  await forum.updatePost(
    owner,
    "post",
    edit({ ...original, title: "새 제목만 수정" }),
  );
  expect((await forum.updatePost(owner, "post", edit(original))).status).toBe(
    "published",
  );
  expect(forum.getPost("post")?.title).toBe(original.title);
  expect(JSON.parse(mocks.jev.mock.calls[1][0])).toEqual(original);
  expect(counts()).toContainEqual({
    request_key: `post:post:${publication.payloadHash(original)}`,
    attempts: 1,
  });
  expect(
    db
      .prepare("SELECT * FROM post_payloads WHERE payload_hash=?")
      .get(publication.payloadHash(original)),
  ).toEqual(originalReceipt);
  seed("other-post", "held", owner, {
    ...original,
    body: "다른 글의 과거에 저장한 합성 본문입니다.",
  });
  db.prepare("UPDATE posts SET body=? WHERE id='other-post'").run(
    "다른 글의 현재에 저장한 합성 본문입니다.",
  );
  await expect(
    forum.updatePost(
      owner,
      "post",
      edit({ ...revised, body: "다른 글의 과거에 저장한 합성 본문입니다." }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(db.prepare("SELECT count(*) n FROM post_payloads").get()).toEqual({
    n: 3,
  });
  expect(mocks.duplicate).toHaveBeenCalledTimes(2);
  expect(mocks.jev).toHaveBeenCalledTimes(2);
});

it.each([2, 3])(
  "preserves old snapshot attempt count %s and fails closed at its limit on restoration",
  async (attempts) => {
    seed();
    const key = `post:post:${publication.payloadHash(original)}`;
    db.prepare("INSERT INTO publication_attempts VALUES(?,?)").run(
      key,
      attempts,
    );
    await forum.updatePost(owner, "post", edit());
    const result = await forum.updatePost(owner, "post", edit(original));
    expect(result.status).toBe(attempts === 2 ? "published" : "pending");
    expect(counts()).toContainEqual({ request_key: key, attempts: 3 });
    expect(mocks.duplicate).toHaveBeenCalledTimes(attempts === 2 ? 2 : 1);
    expect(mocks.jev).toHaveBeenCalledTimes(attempts === 2 ? 2 : 1);
    expect(db.prepare("SELECT count(*) n FROM post_payloads").get()).toEqual({
      n: 2,
    });
    if (attempts === 3) {
      expect(forum.getPost("post")).toBeNull();
      expect(forum.getPost("post", owner.id)?.body).toBe(original.body);
      expect(
        db
          .prepare("SELECT screening_evidence FROM posts WHERE id='post'")
          .get(),
      ).toEqual({
        screening_evidence: JSON.stringify({ reason: "attempt_limit" }),
      });
    }
  },
);

it("blocks another post's exact payload and keeps new-create historical replay prevention", async () => {
  seed();
  seed("other-post", "held", owner, revised);
  await expect(
    forum.updatePost(owner, "post", edit(revised)),
  ).rejects.toMatchObject({ status: 409 });
  db.prepare("UPDATE posts SET title=?,body=? WHERE id='other-post'").run(
    "다른 글의 새 제목",
    "다른 글의 새로운 합성 본문으로 변경합니다.",
  );
  await expect(
    forum.updatePost(owner, "post", edit(revised)),
  ).rejects.toMatchObject({ status: 409 });
  const changed = {
    ...original,
    body: "자기 글에 별도의 새로운 분석 결과를 추가합니다.",
  };
  await forum.updatePost(owner, "post", edit(changed));
  const attempts = counts();
  const limits = db
    .prepare("SELECT * FROM publication_limits ORDER BY scope")
    .all();
  expect(await forum.createPost(owner, original)).toEqual({
    id: "post",
    status: "published",
  });
  expect(counts()).toEqual(attempts);
  expect(
    db.prepare("SELECT * FROM publication_limits ORDER BY scope").all(),
  ).toEqual(limits);
  await expect(
    forum.createPost(owner, { ...original, title: "새 글로 위장한 과거 본문" }),
  ).rejects.toMatchObject({ status: 409 });
  expect(db.prepare("SELECT count(*) n FROM posts").get()).toEqual({ n: 2 });
  expect(db.prepare("SELECT count(*) n FROM post_payloads").get()).toEqual({
    n: 3,
  });
  expect(mocks.jev).toHaveBeenCalledTimes(1);
});

it("keeps duplicate-gate holds private without invoking Jev", async () => {
  seed();
  mocks.duplicate.mockResolvedValueOnce({
    ...assessment,
    verdict: "duplicate",
  });
  expect((await forum.updatePost(owner, "post", edit())).status).toBe("held");
  expect(forum.getPost("post")).toBeNull();
  expect(mocks.jev).not.toHaveBeenCalled();
});

it.each([
  { expectedHash: "invalid" },
  { title: "x" },
  { body: "short" },
  { kind: "invalid" },
  { tags: Array(6).fill("tag") },
])("validates edit input using existing post rules: %o", async (invalid) => {
  seed();
  await expect(
    forum.updatePost(owner, "post", { ...edit(), ...invalid }),
  ).rejects.toMatchObject({ status: 400 });
  expect(forum.getPost("post")?.body).toBe(original.body);
  expect(mocks.duplicate).not.toHaveBeenCalled();
});

it("PATCH uses a real session, rejects origin and forgery, and returns published/private/error statuses", async () => {
  const signup = await authModule.auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        name: "수정 테스트 회원",
        email: "edit-session@example.test",
        password: "test-password-123456",
      }),
    }),
  );
  expect(signup.status).toBe(200);
  await authModule.auth.handler(new Request(context.mail.at(-1)!));
  const login = await authModule.auth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        email: "edit-session@example.test",
        password: "test-password-123456",
      }),
    }),
  );
  expect(login.status).toBe(200);
  const cookies = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  context.headers = new Headers({ cookie: cookies });
  const viewer = (await authModule.getViewer())!;
  expect(viewer.emailVerified).toBe(true);
  seed("session-post", "published", viewer);
  const route = await import("@/app/api/posts/[id]/route");
  const input = {
    ...revised,
    expectedHash: forum.getEditablePost(viewer, "session-post").expectedHash,
  };
  const patch = (data = input, origin = "http://localhost:3000") =>
    route.PATCH(
      new Request("http://localhost:3000/api/posts/session-post", {
        method: "PATCH",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
      { params: Promise.resolve({ id: "session-post" }) },
    );
  expect((await patch(input, "https://attacker.example")).status).toBe(403);
  context.headers = new Headers();
  expect((await patch()).status).toBe(401);
  context.headers = new Headers({ cookie: "better-auth.session_token=forged" });
  expect((await patch()).status).toBe(401);
  context.headers = new Headers({ cookie: cookies });
  const published = await patch();
  expect(published.status).toBe(200);
  expect(await published.json()).toEqual({
    id: "session-post",
    status: "published",
  });
  expect((await patch({ ...input, title: "다른 수정" })).status).toBe(409);
  mocks.jev.mockRejectedValueOnce(new Error("synthetic API failure"));
  const privateResult = await patch({
    ...revised,
    body: "API 실패로 비공개로 남는 새로운 합성 본문입니다.",
    expectedHash: forum.getEditablePost(viewer, "session-post").expectedHash,
  });
  expect(privateResult.status).toBe(202);
  expect(await privateResult.json()).toEqual({
    id: "session-post",
    status: "pending",
  });
  expect(forum.getPost("session-post")).toBeNull();
});
