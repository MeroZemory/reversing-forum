import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));
const related = vi.hoisted(() => vi.fn());
vi.mock("@/server/db", () => storage);
vi.mock("@/server/auth", () => ({ getViewer: async () => null }));
vi.mock("@/server/duplicates/index", () => ({
  relatedPublicPosts: related,
  recordPublishedRelations: vi.fn(),
}));
vi.mock("@/server/resource-curation", () => ({
  currentResourceSelection: () => new Map(),
}));
vi.mock("@/server/publication-notice", () => ({ publicationNotice: vi.fn() }));
import {
  getPost,
  listAllPublicTopics,
  listPostPage,
  listPosts,
  listPublicTopics,
} from "@/server/forum";
import {
  loadFeedScreen,
  loadPostScreen,
  loadResourcesScreen,
} from "@/server/screens";
import {
  canonicalTopic,
  topicAliases,
  topicVariants,
} from "@/lib/topic-aliases";
import { plainExcerpt } from "@/lib/plain-excerpt";

beforeEach(() => {
  storage.db = new Database(":memory:");
  storage.db.exec(`
    CREATE TABLE posts (id TEXT PRIMARY KEY, author_id TEXT, author_name TEXT,
      title TEXT, body TEXT, kind TEXT, tags TEXT, status TEXT, created_at TEXT);
    CREATE TABLE comments (id TEXT, post_id TEXT, parent_id TEXT, author_id TEXT,
      author_name TEXT, body TEXT, created_at TEXT);
    CREATE TABLE editorial_receipts (post_id TEXT UNIQUE, provenance TEXT);
  `);
  vi.stubEnv("EDITORIAL_AUTHOR_USER_ID", "editor");
  related.mockResolvedValue({ relatedPostIds: [] });
});
afterEach(() => {
  storage.db.close();
  vi.unstubAllEnvs();
});

function seed(
  id: string,
  options: {
    title?: string;
    body?: string;
    kind?: string;
    tags?: string[];
    status?: string;
    date?: string;
    author?: string;
  } = {},
) {
  storage.db
    .prepare("INSERT INTO posts VALUES(?,?,?,?,?,?,?,?,?)")
    .run(
      id,
      options.author ?? "member",
      "회원",
      options.title ?? "제목",
      options.body ?? "본문",
      options.kind ?? "analysis",
      JSON.stringify(options.tags ?? []),
      options.status ?? "published",
      options.date ?? "2026-10-05",
    );
}

describe("public discovery contracts", () => {
  it("does not let malformed private tags break public discovery", () => {
    seed("public", { tags: ["Windows"] });
    seed("private", { status: "held" });
    storage.db
      .prepare("UPDATE posts SET tags=? WHERE id=?")
      .run("malformed", "private");
    expect(listAllPublicTopics()).toEqual([{ tag: "Windows", count: 1 }]);
    expect(
      listPostPage({ query: "Windows" }).posts.map((post) => post.id),
    ).toEqual(["public"]);
    expect(
      listPostPage({ tag: "Windows" }).posts.map((post) => post.id),
    ).toEqual(["public"]);
  });
  it.each(["constructor", "toString", "__proto__"])(
    "treats inherited property names as ordinary search/tag text: %s",
    (name) => {
      expect(topicVariants(name)).toEqual([name]);
      seed("match", { title: name, tags: [name] });
      expect(
        listPostPage({ query: name }).posts.map((post) => post.id),
      ).toEqual(["match"]);
      expect(listPostPage({ tag: name }).posts.map((post) => post.id)).toEqual([
        "match",
      ]);
    },
  );
  it("provides the full canonical resource index while limiting sidebar topics to fourteen", () => {
    for (let index = 0; index < 105; index++) {
      seed(`topic-${index}`, { tags: [`topic-${index}`] });
    }
    seed("held", { status: "held", tags: ["private-topic"] });
    expect(listAllPublicTopics()).toHaveLength(105);
    expect(loadResourcesScreen({ q: "missing" })?.topics).toHaveLength(105);
    expect(loadFeedScreen({}).topTopics).toHaveLength(14);
    expect(listPublicTopics(1000)).toHaveLength(100);
  });
  it("merges all eleven alias groups without counting a post twice or exposing private topics", () => {
    expect(Object.keys(topicAliases)).toHaveLength(11);
    for (const [canonical, aliases] of Object.entries(topicAliases)) {
      for (const alias of [canonical, ...aliases]) {
        expect(canonicalTopic(alias.toUpperCase())).toBe(canonical);
        expect(topicVariants(alias)).toContain(canonical);
      }
    }
    seed("one", {
      tags: ["역공학", "리버싱", "리버스 엔지니어링", "IDA Pro", "ida"],
    });
    seed("two", { tags: ["역공학"] });
    seed("held", { status: "held", tags: ["역공학", "secret"] });
    seed("pending", { status: "pending", tags: ["secret"] });
    expect(
      listPostPage({ tag: "리버싱" }).posts.map((post) => post.id),
    ).toEqual(["one", "two"]);
    expect(listPostPage({ query: "리버싱" }).total).toBe(2);
    expect(listPostPage({ query: "리버스 엔지니어링" }).total).toBe(2);
    expect(listAllPublicTopics()).toEqual([
      { tag: "리버싱", count: 2 },
      { tag: "IDA", count: 1 },
    ]);
    expect(listPublicTopics(1)).toHaveLength(1);
    expect(loadResourcesScreen({})?.topics).toEqual(listAllPublicTopics());
    expect(listPostPage({ tag: "' OR 1=1 --" }).total).toBe(0);
    expect(listPostPage({ query: "%" }).total).toBe(0);
  });

  it("returns unanswered ordinary member questions only and compares purposes within tag/query/open", () => {
    for (let index = 0; index < 7; index++)
      seed(`q${index}`, { kind: "question", tags: ["역공학"], title: "조건" });
    seed("answer", { kind: "question", tags: ["역공학"], title: "조건" });
    storage.db
      .prepare(
        "INSERT INTO comments VALUES('reply','answer',NULL,'member','회원','답변','today')",
      )
      .run();
    seed("held", { kind: "question", status: "held", tags: ["역공학"] });
    seed("pending", { kind: "question", status: "pending", tags: ["역공학"] });
    seed("share", { tags: ["역공학"], title: "조건" });
    seed("free", { kind: "discussion", tags: ["역공학"], title: "조건" });
    seed("other-topic", {
      kind: "question",
      tags: ["Linux"],
      title: "다른 조건",
    });
    const data = loadFeedScreen({
      purpose: "question",
      tag: "리버싱",
      q: "조건",
    });
    expect(data.purposeCounts).toEqual({
      question: 8,
      share: 1,
      discussion: 1,
    });
    const questions = loadFeedScreen(
      { tag: "리버싱", q: "조건", page: "999" },
      {
        open: true,
        basePath: "/questions",
        title: "답을 기다리는 질문",
      },
    );
    expect(questions.result.total).toBe(7);
    expect(questions.openCount).toBe(8);
    expect(questions.openPreview).toHaveLength(5);
    expect(questions.purposeCounts).toEqual({
      question: 7,
      share: 0,
      discussion: 0,
    });
    expect(questions.title).toBe("답을 기다리는 질문");
    expect(questions.from).toBe(
      "/questions?tag=%EB%A6%AC%EB%B2%84%EC%8B%B1&q=%EC%A1%B0%EA%B1%B4&open=1",
    );
    expect(JSON.stringify(questions)).not.toContain('"body"');
    expect(getPost("held")).toBeNull();
    expect(getPost("held", "member")?.status).toBe("held");
  });

  it("sums title3/exact3/partial2/body1 and breaks ties by date then id", () => {
    seed("sum", { title: "리버싱", body: "리버싱", tags: ["역공학"] });
    seed("title-a", { title: "리버싱", date: "2020" });
    seed("title-b", { title: "리버싱", date: "2020" });
    seed("exact", { tags: ["역공학"], date: "2021" });
    seed("partial", { tags: ["리버싱 도구"], date: "2025" });
    seed("body", { body: "리버싱", date: "2026" });
    seed("held", {
      title: "리버싱",
      body: "리버싱",
      tags: ["역공학"],
      status: "held",
    });
    const expected = ["sum", "exact", "title-a", "title-b", "partial", "body"];
    expect(
      listPostPage({ query: "리버싱" }).posts.map((post) => post.id),
    ).toEqual(expected);
    expect(listPosts({ query: "리버싱" }).map((post) => post.id)).toEqual(
      expected,
    );
    expect(
      listPostPage({ query: "리버싱", pageSize: 2, page: 2 }).posts.map(
        (post) => post.id,
      ),
    ).toEqual(expected.slice(2, 4));
  });

  it("projects plain220 and editorial metadata while keeping stored titles/bodies unchanged", () => {
    const body =
      "# 제목\n**강조**와 `코드`, [문서](https://example.test)\n> 인용\n- 항목\n```ts\nsecretCode\n```\n| 표 | 내용 |\n" +
      "설명 ".repeat(100) +
      "\n### 편집자 보충\n보충 내용\n출처: [하나](https://one.test) · [둘](https://two.test)";
    seed("editorial", { title: "원래 제목", body, author: "editor" });
    seed("member", { body });
    storage.db.prepare("INSERT INTO editorial_receipts VALUES(?,?)").run(
      "editorial",
      JSON.stringify({
        type: "chat-editorial",
        period: "2020–2021",
        verificationSummary: "확인",
        privateEvidence: "never-public",
      }),
    );
    const data = loadFeedScreen({ tag: "missing" });
    const editorial = listPostPage().posts.find(
      (post) => post.id === "editorial",
    )!;
    expect(editorial).toMatchObject({
      recordPeriod: "2020–2021",
      sourceCount: 2,
    });
    const projected = loadFeedScreen({}).result.posts.find(
      (post) => post.id === "editorial",
    )!;
    expect(projected.recordPeriod).toBe("2020–2021");
    expect(projected.sourceCount).toBe(2);
    expect(projected.excerpt).toHaveLength(220);
    expect(projected.excerpt).toMatch(/^강조와 코드, 문서 인용 항목/);
    expect(projected.excerpt).not.toMatch(
      /보충|출처|secretCode|https:|[*`#|<>]/,
    );
    expect(
      listPostPage().posts.find((post) => post.id === "member"),
    ).not.toHaveProperty("recordPeriod");
    expect(JSON.stringify({ data, projected })).not.toContain("never-public");
    expect(getPost("editorial")?.body).toBe(body);
    expect(
      storage.db
        .prepare("SELECT title, body FROM posts WHERE id='editorial'")
        .get(),
    ).toEqual({ title: "원래 제목", body });
    expect(plainExcerpt("### 편집자 보충\n보충만 있음")).toBe("");
  });

  it("ranks same-topic public posts by rarity, deduplicates aliases and excludes related overlap", async () => {
    seed("mine", { tags: ["리버싱", "rare"] });
    seed("overlap", { tags: ["rare"] });
    seed("rare", { tags: ["rare"], date: "2020" });
    seed("common-a", { tags: ["역공학", "리버싱"], date: "2024" });
    seed("common-b", { tags: ["리버스 엔지니어링"], date: "2024" });
    seed("common-c", { tags: ["리버싱"], date: "2024" });
    seed("held", { tags: ["rare"], status: "held" });
    seed("unrelated", { tags: ["Linux"] });
    related.mockResolvedValue({ relatedPostIds: ["overlap", "held"] });
    const from = "/questions?tag=rare&open=1";
    const data = await loadPostScreen("mine", { from });
    expect(data?.relatedPosts?.map((post) => post.id)).toEqual(["overlap"]);
    expect(data?.sameTopicPosts?.map((post) => post.id)).toEqual([
      "rare",
      "common-a",
      "common-b",
    ]);
    expect(data?.returnTo).toBe(from);
    expect(data?.sameTopicPosts?.[0]).not.toHaveProperty("body");
  });
});
