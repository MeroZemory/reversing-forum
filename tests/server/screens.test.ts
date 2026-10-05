import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostDetail, Viewer } from "@/lib/types";

const services = vi.hoisted(() => ({
  getViewer: vi.fn(),
  getPost: vi.fn(),
  getEditablePost: vi.fn(),
  listComments: vi.fn(),
  listMyPosts: vi.fn(),
  listPostPage: vi.fn(),
  listPublicTopics: vi.fn(),
  listAllPublicTopics: vi.fn(),
  relatedPublicPosts: vi.fn(),
  publicationNotice: vi.fn(),
}));
vi.mock("@/server/auth", () => ({ getViewer: services.getViewer }));
vi.mock("@/server/forum", () => ({
  ...services,
  ForumError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/server/duplicates/index", () => ({
  relatedPublicPosts: services.relatedPublicPosts,
}));
vi.mock("@/server/publication-notice", () => ({
  publicationNotice: services.publicationNotice,
}));
vi.mock("@/server/resource-curation", () => ({
  currentResourceSelection: () => undefined,
}));
import {
  loadAuthScreen,
  loadFeedScreen,
  loadMyPostsScreen,
  loadNewPostScreen,
  loadEditPostScreen,
  loadPostScreen,
  loadViewer,
  loadResourcesScreen,
} from "@/server/screens";
import { ForumError } from "@/server/forum";

const viewer: Viewer = {
  id: "member",
  name: "연구자",
  email: "private@example.test",
};
const post: PostDetail = {
  id: "post",
  title: "분기 조건 분석",
  excerpt: "분기 조건을 확인했습니다.",
  body: "작성자가 정리한 분석 과정",
  kind: "analysis",
  tags: ["Ghidra"],
  author: { id: "member", name: "연구자" },
  createdAt: "2026-10-02T00:00:00.000Z",
  commentCount: 0,
  status: "published",
};
beforeEach(() => {
  vi.resetAllMocks();
  services.getViewer.mockResolvedValue(null);
  services.getPost.mockReturnValue(null);
  services.getEditablePost.mockReturnValue({
    post,
    expectedHash: "a".repeat(64),
  });
  services.listMyPosts.mockReturnValue([]);
  services.listComments.mockReturnValue([]);
  services.listPublicTopics.mockReturnValue([]);
  services.listAllPublicTopics.mockReturnValue([]);
  services.listPostPage.mockReturnValue({
    posts: [],
    total: 0,
    page: 1,
    pageSize: 30,
    pageCount: 1,
  });
  services.relatedPublicPosts.mockResolvedValue({ relatedPostIds: [] });
  services.publicationNotice.mockReturnValue(null);
});

describe("screen data boundary", () => {
  it("preserves the edit destination through login and sends only the editable payload to the client", async () => {
    const from = "/me?status=held";
    const guest = await loadEditPostScreen(post.id, { from });
    expect(guest?.kind).toBe("redirect");
    if (guest?.kind === "redirect") {
      expect(
        new URL(guest.href, "https://example.test").searchParams.get(
          "returnTo",
        ),
      ).toBe(`/posts/post/edit?from=${encodeURIComponent(from)}`);
    }
    services.getViewer.mockResolvedValue({
      ...viewer,
      emailVerified: true,
      nicknameReady: true,
    });
    const own = await loadEditPostScreen(post.id, { from });
    expect(own).toEqual({
      kind: "ready",
      data: {
        viewerId: viewer.id,
        from,
        editing: {
          id: post.id,
          title: post.title,
          body: post.body,
          kind: post.kind,
          tags: post.tags,
          expectedHash: "a".repeat(64),
        },
      },
    });
    expect(JSON.stringify(own)).not.toContain(viewer.email);
    expect(JSON.stringify(own)).not.toContain("screening_evidence");
  });
  it("never offers an editor link when the server rejects a receipt-linked post", async () => {
    services.getViewer.mockResolvedValue(viewer);
    services.getPost.mockReturnValue(post);
    services.getEditablePost.mockImplementation(() => {
      throw new ForumError(403, "편집 자료");
    });
    expect((await loadPostScreen(post.id, {}))?.editHref).toBeUndefined();
    expect(await loadEditPostScreen(post.id, {})).toBeNull();
  });
  it("shows the edit link only on the author's ordinary post", async () => {
    services.getViewer.mockResolvedValue(viewer);
    services.getPost.mockReturnValue(post);
    expect((await loadPostScreen(post.id, { from: "/me" }))?.editHref).toBe(
      "/posts/post/edit?from=%2Fme",
    );
    services.getViewer.mockResolvedValue({ ...viewer, id: "other" });
    expect((await loadPostScreen(post.id, {}))?.editHref).toBeUndefined();
  });
  it("keeps a resource route through detail, comments and guest write login", async () => {
    services.getPost.mockReturnValue(post);
    const from = "/resources/executables?tag=Ghidra&page=2";
    const data = await loadPostScreen(post.id, { from });
    expect(data?.returnTo).toBe(from);
    expect(
      new URL(data!.postPath, "https://example.test").searchParams.get("from"),
    ).toBe(from);
    const result = await loadNewPostScreen({ from, tag: "Ghidra" });
    expect(result.kind).toBe("redirect");
    if (result.kind === "redirect") {
      const target = new URL(
        result.href,
        "https://example.test",
      ).searchParams.get("returnTo")!;
      expect(
        new URL(target, "https://example.test").searchParams.get("from"),
      ).toBe(from);
    }
  });
  it("projects resource summaries and clamps filtered return pages", () => {
    services.listPostPage.mockReturnValue({
      posts: [{ ...post, id: "2ce239d2-fb37-457c-a9ed-08bbf37fb67e" }],
      total: 1,
      page: 1,
      pageSize: 100,
      pageCount: 1,
    });
    const data = loadResourcesScreen(
      { page: "999", tag: "Ghidra" },
      "executables",
    )!;
    expect(data.feed.from).toBe("/resources/executables?tag=Ghidra");
    expect(data.feed.result.posts[0]).not.toHaveProperty("body");
    expect(loadResourcesScreen({}, "unknown")).toBeNull();
  });
  it("keeps 15 editorial posts visible and compacts only bulk quiet editorial posts", () => {
    const editorial = Array.from({ length: 30 }, (_, index) => ({
      ...post,
      id: `editor-${index}`,
      author: { id: "editor", name: "자료편집", role: "editor" as const },
      commentCount: index === 0 ? 1 : 0,
    }));
    const serve = (posts: typeof editorial) =>
      services.listPostPage.mockImplementation(({ pageSize = 30 }) => ({
        posts: posts.slice(0, pageSize),
        total: posts.length,
        page: 1,
        pageSize,
        pageCount: Math.ceil(posts.length / pageSize),
      }));
    serve(editorial.slice(0, 15));
    expect(loadFeedScreen({}).result.posts).toHaveLength(15);
    expect(loadFeedScreen({}).compactEditorial).toBeUndefined();
    const quietOnly = editorial.map((value) => ({ ...value, commentCount: 0 }));
    serve(quietOnly);
    const initial = loadFeedScreen({});
    expect(initial.compactEditorial).toBeUndefined();
    expect(initial.result.posts).toHaveLength(30);
    serve([
      ...editorial,
      { ...post, id: "member" } as (typeof editorial)[number],
    ]);
    const data = loadFeedScreen({});
    expect(data.result.posts.map((value) => value.id)).toEqual([
      "editor-0",
      "member",
    ]);
    expect(data.compactEditorial).toMatchObject({
      total: 29,
      activityTotal: 2,
    });
    expect(data.compactEditorial!.posts).toHaveLength(3);
    expect(
      loadFeedScreen({ purpose: "share" }).compactEditorial,
    ).toBeUndefined();
  });
  it("paginates real activity separately from the all-public count", () => {
    const editors = Array.from({ length: 30 }, (_, index) => ({
      ...post,
      id: `editor-${index}`,
      author: { id: "editor", name: "자료편집", role: "editor" as const },
    }));
    const members = Array.from({ length: 35 }, (_, index) => ({
      ...post,
      id: `member-${index}`,
    }));
    const all = [...editors, ...members];
    services.listPostPage.mockImplementation(({ page = 1, pageSize = 30 }) => {
      const pageCount = Math.ceil(all.length / pageSize);
      const currentPage = Math.min(page, pageCount);
      return {
        posts: all.slice((currentPage - 1) * pageSize, currentPage * pageSize),
        total: all.length,
        page: currentPage,
        pageSize,
        pageCount,
      };
    });
    const data = loadFeedScreen({ page: "999" });
    expect(data.result).toMatchObject({ total: 65, page: 2, pageCount: 2 });
    expect(data.result.posts.map((value) => value.id)).toEqual(
      members.slice(30).map((value) => value.id),
    );
    expect(data.compactEditorial).toMatchObject({
      total: 30,
      activityTotal: 35,
    });
    expect(data.from).toBe("/?page=2");
  });
  it("projects session identity without exposing email or provider fields", async () => {
    services.getViewer.mockResolvedValue({
      ...viewer,
      providerToken: "private-token",
    });
    expect(await loadViewer()).toEqual({ id: viewer.id, name: viewer.name });
  });
  it("uses the clamped result page for return context and carries write intent", () => {
    services.listPostPage.mockReturnValue({
      posts: [post],
      total: 1,
      page: 1,
      pageSize: 30,
      pageCount: 1,
    });
    const data = loadFeedScreen({
      purpose: "share",
      tag: "Ghidra",
      q: "分支",
      page: "999",
    });
    expect(
      new URL(data.from, "https://example.test").searchParams.get("page"),
    ).toBeNull();
    const query = new URL(data.writeHref, "https://example.test").searchParams;
    expect(query.get("from")).toBe(data.from);
    expect(query.get("purpose")).toBe("share");
    expect(query.get("tag")).toBe("Ghidra");
  });
  it("redirects guests before accessing private account data and preserves intent", async () => {
    const own = await loadMyPostsScreen({ status: "held" });
    expect(own).toEqual({
      kind: "redirect",
      href: "/login?returnTo=%2Fme%3Fstatus%3Dheld",
    });
    expect(services.listMyPosts).not.toHaveBeenCalled();
    const editor = await loadNewPostScreen({
      purpose: "share",
      tag: "Ghidra",
      from: "/me?status=held",
    });
    expect(editor.kind).toBe("redirect");
    if (editor.kind === "redirect") {
      const target = new URL(
        editor.href,
        "https://example.test",
      ).searchParams.get("returnTo")!;
      expect(
        new URL(target, "https://example.test").searchParams.get("from"),
      ).toBe("/me?status=held");
    }
  });
  it("selects my posts on the server while projecting bodies out of list data", async () => {
    services.getViewer.mockResolvedValue(viewer);
    services.listMyPosts.mockReturnValue([
      post,
      { ...post, id: "held", status: "held" },
    ]);
    const result = await loadMyPostsScreen({ status: "held" });
    expect(services.listMyPosts).toHaveBeenCalledWith(viewer.id);
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.data.total).toBe(2);
      expect(result.data.counts).toEqual({ published: 1, pending: 0, held: 1 });
      expect(result.data.posts.map((value) => value.id)).toEqual(["held"]);
      expect(result.data.posts[0]).not.toHaveProperty("body");
    }
  });
  it("loads posts under the server session and does not fetch comments for unavailable content", async () => {
    services.getViewer.mockResolvedValue(viewer);
    expect(await loadPostScreen("missing", {})).toBeNull();
    expect(services.getPost).toHaveBeenCalledWith("missing", viewer.id);
    expect(services.listComments).not.toHaveBeenCalled();
  });
  it("preserves the original account filter after the post becomes public", async () => {
    services.getViewer.mockResolvedValue(viewer);
    services.getPost.mockReturnValue(post);
    const data = await loadPostScreen(post.id, { from: "/me?status=held" });
    expect(data?.returnTo).toBe("/me?status=held");
    expect(data?.fromMyPosts).toBe(true);
    expect(data?.viewer).toEqual({ id: viewer.id, name: viewer.name });
    expect(services.listComments).toHaveBeenCalledWith(post.id);
  });
  it("keeps private-post comments out and rejects unsafe return destinations", async () => {
    services.getViewer.mockResolvedValue(viewer);
    services.getPost.mockReturnValue({ ...post, status: "held" });
    const data = await loadPostScreen(post.id, { from: "//external.test" });
    expect(data?.returnTo).toBe("/me");
    expect(data?.comments).toEqual([]);
    expect(services.listComments).not.toHaveBeenCalled();
    expect(
      await loadAuthScreen("login", { returnTo: "https://external.test" }),
    ).toEqual({ kind: "redirect", href: "/" });
  });
  it("permits explicit reauthentication and keeps its account destination", async () => {
    services.getViewer.mockResolvedValue(viewer);
    expect(
      await loadAuthScreen("login", { reauth: "1", returnTo: "/account" }),
    ).toEqual({
      kind: "ready",
      data: { mode: "login", returnTo: "/account" },
    });
    expect(await loadAuthScreen("login", { returnTo: "/account" })).toEqual({
      kind: "redirect",
      href: "/account",
    });
  });
});
