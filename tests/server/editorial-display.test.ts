import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PostDetail } from "@/lib/types";

const storage = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));
vi.mock("@/server/db", () => storage);
vi.mock("@/server/jev", () => ({ screenPost: vi.fn() }));
vi.mock("@/server/auth", () => ({ getViewer: async () => null }));
import * as forum from "@/server/forum";
import { loadFeedScreen, loadPostScreen } from "@/server/screens";
import { editorialDisplayName } from "@/lib/editorial-labels";
import { EditorialAuthor } from "@/components/ui/editorial-author";
import { PostScreen } from "@/components/screens/post-screen";

const publishedAt = "2026-10-02T01:00:00.000Z";
const provenance = {
  type: "chat-editorial",
  period: "2020–2021",
  verificationSummary:
    "도구 설명은 대조했으며 현재 버전의 동작은 미확인입니다.",
  privateEvidence: "private-proof",
  aliases: ["private-alias"],
  rights: "private-rights",
};

beforeEach(() => {
  storage.db = new Database(":memory:");
  storage.db.exec(`
    CREATE TABLE posts (
      id TEXT PRIMARY KEY, author_id TEXT, author_name TEXT, title TEXT, body TEXT,
      kind TEXT, tags TEXT, status TEXT, created_at TEXT, screening_evidence TEXT
    );
    CREATE TABLE comments (
      id TEXT, post_id TEXT, parent_id TEXT, author_id TEXT, author_name TEXT,
      body TEXT, created_at TEXT
    );
  `);
  vi.stubEnv("EDITORIAL_AUTHOR_USER_ID", "editor-account");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  storage.db.close();
});
afterAll(() => vi.resetModules());

function post(id: string, author = "editor-account", status = "published") {
  storage.db
    .prepare("INSERT INTO posts VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(
      id,
      author,
      "자료편집",
      "분석 자료",
      "분석 과정을 정리했습니다.",
      "analysis",
      '["assembly"]',
      status,
      publishedAt,
      "private-screening",
    );
}
function receipts() {
  storage.db.exec(`CREATE TABLE editorial_receipts (
    post_id TEXT UNIQUE, candidate_key TEXT, revision INTEGER, hash TEXT, provenance TEXT
  )`);
}
function receipt(id: string, value: unknown = provenance) {
  storage.db
    .prepare("INSERT INTO editorial_receipts VALUES(?,?,?,?,?)")
    .run(
      id,
      `private-candidate-${id}`,
      1,
      "private-hash",
      JSON.stringify(value),
    );
}

describe("editorial public projection", () => {
  it("supports the baseline schema without importing the real database", () => {
    post("ordinary", "member");
    expect(forum.getPost("ordinary")?.author).toEqual({
      id: "member",
      name: "자료편집",
    });
    expect(forum.listPosts()[0]).not.toHaveProperty("editorial");
    expect(forum.listPostPage().total).toBe(1);
  });

  it("requires both the fixed account and a valid published receipt", () => {
    receipts();
    post("editorial");
    receipt("editorial");
    post("imposter", "member");
    receipt("imposter");
    post("no-receipt");
    post("invalid");
    receipt("invalid", { type: "unknown" });
    expect(forum.getPost("editorial")?.author).toEqual({
      id: "editor-account",
      name: "자료편집",
      role: "editor",
    });
    for (const id of ["imposter", "no-receipt", "invalid"]) {
      expect(forum.getPost(id)?.author).not.toHaveProperty("role");
    }
    expect(forum.getPost("editorial")?.editorial).toEqual({
      sourceType: "chat-editorial",
      period: provenance.period,
      verificationSummary: provenance.verificationSummary,
    });
    expect(forum.getPost("editorial")?.createdAt).toBe(publishedAt);
    for (const value of [
      forum.getPost("editorial"),
      forum.listPosts(),
      forum.listPostPage(),
    ]) {
      expect(JSON.stringify(value)).not.toMatch(
        /private-|candidate_key|screening_evidence/,
      );
    }
    expect(forum.listPosts()[0]).not.toHaveProperty("editorial");
  });

  it("keeps pending and held posts private despite receipts", () => {
    receipts();
    for (const status of ["pending", "held"]) {
      post(status, "editor-account", status);
      receipt(status);
      expect(forum.getPost(status)).toBeNull();
      expect(forum.getPost(status, "member")).toBeNull();
      expect(
        forum.getPost(status, "editor-account")?.author,
      ).not.toHaveProperty("role");
      expect(forum.getPost(status, "editor-account")).not.toHaveProperty(
        "editorial",
      );
    }
    expect(forum.listPosts()).toEqual([]);
    expect(forum.listPostPage().total).toBe(0);
    expect(forum.listPublicTopics()).toEqual([]);
  });

  it("projects screen contracts explicitly even if a service returns extra fields", async () => {
    receipts();
    post("editorial");
    receipt("editorial");
    const clean = forum.getPost("editorial")!;
    const unsafe = {
      ...clean,
      privateEvidence: "private-proof",
      hash: "private-hash",
      author: { ...clean.author, email: "private-email" },
      editorial: { ...clean.editorial, aliases: ["private-alias"] },
    } as PostDetail;
    vi.spyOn(forum, "getPost").mockReturnValue(unsafe);
    vi.spyOn(forum, "listPostPage").mockReturnValue({
      posts: [unsafe],
      total: 1,
      page: 1,
      pageSize: 30,
      pageCount: 1,
    });
    const data = await loadPostScreen("editorial", {});
    expect(data?.post.editorial).toEqual(clean.editorial);
    expect(JSON.stringify(data)).not.toMatch(/private-|email|aliases/);
    expect(JSON.stringify(loadFeedScreen({}))).not.toMatch(
      /private-|email|aliases/,
    );
    expect(loadFeedScreen({}).result.posts[0]).not.toHaveProperty("body");
  });
});

describe("editorial display", () => {
  it("labels independent guides separately and shows absent verification explicitly", () => {
    receipts();
    post("guide");
    receipt("guide", {
      type: "independent-guide",
      period: "",
      verificationSummary: "",
    });
    const data = {
      post: forum.getPost("guide")!,
      comments: [],
      viewer: null,
      returnTo: "/",
      fromMyPosts: false,
      postPath: "/posts/guide",
      publicUrl: "https://example.test/posts/guide",
    };
    const markup = renderToStaticMarkup(
      createElement(PostScreen, { data, commentsSlot: null }),
    );
    expect(markup).toContain("별도로 작성한 안내 자료");
    expect(markup).toContain("기간 미확인");
    expect(markup).toContain("확인 상태가 기록되지 않았습니다.");
    expect(markup).not.toContain("과거 카톡 대화를 가공한 자료");
    const ordinary = renderToStaticMarkup(
      createElement(PostScreen, {
        data: {
          ...data,
          post: {
            ...data.post,
            author: { id: "member", name: "자료편집" },
            editorial: undefined,
          },
        },
        commentsSlot: null,
      }),
    );
    expect(ordinary).toContain('"@type":"Person"');
    expect(ordinary).not.toContain("운영계정");
    expect(ordinary).not.toContain("자료 출처");
    expect(ordinary).not.toContain("editorial-provenance");
    expect(ordinary).not.toContain("<details");
  });

  it("uses explicit language labels and English for unsupported locales", () => {
    expect(editorialDisplayName()).toBe("자료편집");
    for (const [locale, name] of Object.entries({
      "ko-KR": "자료편집",
      "en-US": "Editorial",
      fr: "Rédaction",
      de: "Redaktion",
      es: "Edición",
      unsupported: "Editorial",
      constructor: "Editorial",
    }))
      expect(editorialDisplayName(locale)).toBe(name);
    const ordinary = renderToStaticMarkup(
      createElement(EditorialAuthor, {
        author: { id: "member", name: "자료편집" },
      }),
    );
    expect(ordinary).not.toContain("운영계정");
  });

  it("separates historical provenance from publication and preserves uncertainty and comments", () => {
    receipts();
    post("editorial");
    receipt("editorial");
    const markup = renderToStaticMarkup(
      createElement(PostScreen, {
        data: {
          post: forum.getPost("editorial")!,
          comments: [],
          viewer: null,
          returnTo: "/",
          fromMyPosts: false,
          postPath: "/posts/editorial",
          publicUrl: "https://example.test/posts/editorial",
          locale: "fr",
        },
        commentsSlot: createElement("div", { id: "comments" }, "댓글 흐름"),
      }),
    );
    expect(markup).toContain('"@type":"Organization"');
    expect(markup).toContain(`"datePublished":"${publishedAt}"`);
    expect(markup).toContain("Rédaction");
    expect(markup).toContain("Équipe");
    const aside = markup.match(/<aside[^>]*>([\s\S]*?)<\/aside>/)![1];
    const [collapsed, detail] = aside.split("<details>");
    expect(markup).toContain('aria-label="자료 출처와 확인 상태"');
    expect(collapsed).toContain("과거 카톡 편집 자료");
    expect(collapsed).toContain(`과거 기록 기간 · ${provenance.period}`);
    expect(collapsed).toContain("기록 시점과 웹 게시일은 다릅니다.");
    expect(collapsed).toContain("현재 내용·효력은 별도 확인이 필요합니다.");
    expect(collapsed).not.toContain(provenance.verificationSummary);
    expect(detail).toContain("<summary>확인 내역</summary>");
    expect(detail).toContain(provenance.verificationSummary);
    expect(markup).not.toMatch(/<details[^>]*\sopen/);
    expect(markup).toContain("댓글 흐름");
    expect(markup).not.toContain("private-");
  });
});
