import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Viewer } from "@/lib/types";

const context = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => context.headers }));
let forum: typeof import("@/server/forum");
let db: (typeof import("@/server/db"))["db"];
let authModule: typeof import("@/server/auth");
const owner: Viewer = {
  id: "owner",
  name: "작성자",
  email: "owner@example.test",
};
const other: Viewer = {
  id: "other",
  name: "다른 회원",
  email: "other@example.test",
};
const input = {
  title: "어셈블리 분석 질문",
  body: "분석한 코드에 대한 충분한 설명입니다.",
  kind: "analysis",
  tags: ["assembly"],
};

beforeAll(async () => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.BETTER_AUTH_SECRET =
    "test-only-secret-for-isolated-memory-db-0123456789";
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  authModule = await import("@/server/auth");
  ({ db } = await import("@/server/db"));
  const { getMigrations } = await import("better-auth/db/migration");
  await (await getMigrations(authModule.auth.options)).runMigrations();
  forum = await import("@/server/forum");
});
beforeEach(() => {
  db.exec("DELETE FROM comments; DELETE FROM posts;");
  context.headers = new Headers();
  process.env.JEV_MOCK = "pass";
  vi.restoreAllMocks();
});
afterAll(() => {
  db.close();
});

describe("publication and privacy", () => {
  it("persists pending before screening and never exposes it to other viewers", async () => {
    delete process.env.JEV_MOCK;
    process.env.TYPESAFE_API_KEY = "isolated-test-key";
    let release!: (r: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const creating = forum.createPost(owner, input);
    const own = forum.listMyPosts(owner.id)[0];
    expect(own.status).toBe("pending");
    expect(forum.listPosts()).toEqual([]);
    expect(forum.getPost(own.id)).toBeNull();
    expect(forum.getPost(own.id, other.id)).toBeNull();
    const answer = {
      type: "choice",
      choice: "allowed",
      confidence: 0.98,
      probabilities: { allowed: 0.98, violation: 0.01, uncertain: 0.01 },
    };
    release(
      Response.json({
        answers: { spam: answer, harassment: answer, privacy: answer },
      }),
    );
    expect((await creating).status).toBe("published");
    expect(forum.getPost(own.id)?.body).toBe(input.body);
    expect(JSON.stringify(forum.listPosts())).not.toContain("screening");
    expect(JSON.stringify(forum.getPost(own.id))).not.toContain("confidence");
    expect(
      db.prepare("SELECT screening_evidence FROM posts WHERE id=?").get(own.id),
    ).toBeTruthy();
  });
  it.each(["hold", "error"])(
    "keeps %s results private and owner-readable",
    async (mock) => {
      process.env.JEV_MOCK = mock;
      const result = await forum.createPost(owner, input);
      expect(result.status).toBe(mock === "hold" ? "held" : "pending");
      expect(forum.getPost(result.id)).toBeNull();
      expect(forum.getPost(result.id, other.id)).toBeNull();
      expect(forum.getPost(result.id, owner.id)?.status).toBe(result.status);
      expect(forum.listPosts()).toEqual([]);
      expect(() =>
        forum.createComment(owner, result.id, { body: "댓글" }),
      ).toThrow();
    },
  );
  it("rejects unauthenticated writes, invalid lengths, and repeated publication", async () => {
    await expect(forum.createPost(null, input)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      forum.createPost(owner, { ...input, body: "짧음" }),
    ).rejects.toMatchObject({ status: 400 });
    await forum.createPost(owner, input);
    await expect(forum.createPost(owner, input)).rejects.toMatchObject({
      status: 429,
    });
    expect(forum.listPosts()).toHaveLength(1);
  });
});
describe("two-level member comments", () => {
  it("accepts a reply and rejects cross-post replies, reply-to-reply, anonymous writes and flooding", async () => {
    const first = await forum.createPost(owner, input);
    const second = await forum.createPost(other, input);
    const top = forum.createComment(owner, first.id, { body: "원댓글" });
    const reply = forum.createComment(other, first.id, {
      body: "답글",
      parentId: top.id,
    });
    expect(forum.listComments(first.id).map((c) => c.id)).toContain(reply.id);
    expect(() =>
      forum.createComment(null, first.id, { body: "익명" }),
    ).toThrow();
    expect(() =>
      forum.createComment(owner, second.id, {
        body: "다른 글",
        parentId: top.id,
      }),
    ).toThrow(/같은 글/);
    expect(() =>
      forum.createComment(owner, first.id, {
        body: "세 번째 층",
        parentId: reply.id,
      }),
    ).toThrow(/원댓글/);
    expect(() =>
      forum.createComment(owner, first.id, { body: "반복" }),
    ).toThrow(/잠시/);
    expect(() =>
      forum.createComment(owner, first.id, { body: "x".repeat(2001) }),
    ).toThrow();
    expect(forum.listComments(first.id)).toHaveLength(2);
  });
});
describe("Jev fail-closed screening", () => {
  it.each([
    ["malformed JSON", () => new Response("not json"), "held"],
    ["incomplete answers", () => Response.json({ answers: {} }), "held"],
    [
      "API outage",
      () => new Response("unavailable", { status: 503 }),
      "pending",
    ],
    [
      "timeout",
      () => {
        throw new DOMException("timeout", "TimeoutError");
      },
      "pending",
    ],
  ] as const)("handles %s", async (_name, response, status) => {
    delete process.env.JEV_MOCK;
    process.env.TYPESAFE_API_KEY = "isolated-test-key";
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
    expect((await forum.createPost(owner, input)).status).toBe(status);
    expect(forum.listPosts()).toEqual([]);
  });
  it("holds uncertain and low-confidence answers", async () => {
    delete process.env.JEV_MOCK;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        answers: Object.fromEntries(
          ["spam", "harassment", "privacy"].map((k) => [
            k,
            {
              type: "choice",
              choice: "allowed",
              confidence: 0.8,
              probabilities: { allowed: 0.8, violation: 0.1, uncertain: 0.1 },
            },
          ]),
        ),
      }),
    );
    expect((await forum.createPost(owner, input)).status).toBe("held");
  });
  it("does not honor mock bypasses in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unavailable"));
    try {
      expect((await forum.createPost(owner, input)).status).toBe("pending");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("keeps missing-key submissions pending without contacting the API", async () => {
    delete process.env.JEV_MOCK;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_KEY_FILE;
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await forum.createPost(owner, input)).status).toBe("pending");
    expect(fetch).not.toHaveBeenCalled();
  });
});
describe("real BetterAuth sessions and HTTP boundaries", () => {
  it("signs up, validates a cookie on the server, and rejects forged sessions", async () => {
    const signup = await authModule.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          name: "테스트 회원",
          email: "session@example.test",
          password: "test-password-123456",
        }),
      }),
    );
    expect(signup.status).toBe(200);
    const cookies = signup.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookies).toContain("session_token");
    const login = (password: string) =>
      authModule.auth.handler(
        new Request("http://localhost:3000/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost:3000",
          },
          body: JSON.stringify({ email: "session@example.test", password }),
        }),
      );
    expect((await login("wrong-password-123456")).status).toBe(401);
    expect((await login("test-password-123456")).status).toBe(200);
    context.headers = new Headers({ cookie: cookies });
    expect((await authModule.getViewer())?.email).toBe("session@example.test");
    context.headers = new Headers({
      cookie: "better-auth.session_token=forged",
    });
    expect(await authModule.getViewer()).toBeNull();
    context.headers = new Headers();
    const route = await import("@/app/api/posts/route");
    const anonymous = await route.POST(
      new Request("http://localhost:3000/api/posts", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      }),
    );
    expect(anonymous.status).toBe(401);
    const crossSite = await route.POST(
      new Request("http://localhost:3000/api/posts", {
        method: "POST",
        headers: { Origin: "https://attacker.example" },
        body: JSON.stringify(input),
      }),
    );
    expect(crossSite.status).toBe(403);
    context.headers = new Headers({ cookie: cookies });
    process.env.JEV_MOCK = "hold";
    const held = await route.POST(
      new Request("http://localhost:3000/api/posts", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      }),
    );
    expect(held.status).toBe(202);
    const result = await held.json();
    expect(Object.keys(result).sort()).toEqual(["id", "status"]);
    const detailRoute = await import("@/app/api/posts/[id]/route");
    expect(
      (
        await detailRoute.GET(new Request("http://localhost:3000"), {
          params: Promise.resolve({ id: result.id }),
        })
      ).status,
    ).toBe(200);
    context.headers = new Headers();
    expect(
      (
        await detailRoute.GET(new Request("http://localhost:3000"), {
          params: Promise.resolve({ id: result.id }),
        })
      ).status,
    ).toBe(404);
    await authModule.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-out", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          cookie: cookies,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    context.headers = new Headers({ cookie: cookies });
    expect(await authModule.getViewer()).toBeNull();
  });
});
