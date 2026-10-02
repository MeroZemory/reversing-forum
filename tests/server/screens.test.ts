import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostDetail, Viewer } from "@/lib/types";

const services = vi.hoisted(() => ({
  getViewer: vi.fn(),
  getPost: vi.fn(),
  listComments: vi.fn(),
  listMyPosts: vi.fn(),
  listPostPage: vi.fn(),
  listPublicTopics: vi.fn(),
}));
vi.mock("@/server/auth", () => ({ getViewer: services.getViewer }));
vi.mock("@/server/forum", () => services);
import {
  loadAuthScreen,
  loadFeedScreen,
  loadMyPostsScreen,
  loadNewPostScreen,
  loadPostScreen,
  loadViewer,
} from "@/server/screens";

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
  services.listMyPosts.mockReturnValue([]);
  services.listComments.mockReturnValue([]);
  services.listPublicTopics.mockReturnValue([]);
});

describe("screen data boundary", () => {
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
});
