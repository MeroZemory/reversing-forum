import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostSummary } from "@/lib/types";
const service = vi.hoisted(() => ({ listPostPage: vi.fn() }));
vi.mock("@/server/forum", () => service);
import {
  curatedPostIds,
  listResourcePosts,
  resourceGuides,
} from "@/server/resources";

const post: PostSummary = {
  id: "public",
  title: "리버싱 학습 방법에 대한 의견",
  excerpt: "일부 결과와 남은 의문",
  kind: "discussion",
  tags: ["학습 방법"],
  author: { id: "member", name: "회원" },
  createdAt: "2026-10-02T00:00:00Z",
  commentCount: 0,
};
beforeEach(() => vi.resetAllMocks());
describe("operator-curated resource guides", () => {
  it("retains all fifteen initial operator selections", () => {
    expect(curatedPostIds).toHaveLength(15);
    expect(new Set(curatedPostIds).size).toBe(15);
    expect(
      resourceGuides(curatedPostIds.map((id) => ({ ...post, id })))[0].count,
    ).toBe(15);
  });
  it("uses the same topic eligibility for member, editorial and partial opinion posts", () => {
    const editor = {
      ...post,
      id: "editor",
      author: { id: "editor", name: "자료편집", role: "editor" as const },
    };
    const guides = resourceGuides([post, editor], ["public", "editor"]);
    expect(guides.map((guide) => guide.slug)).toEqual(["learning"]);
    expect(guides[0].posts.map((value) => value.id)).toEqual([
      "public",
      "editor",
    ]);
    expect(
      resourceGuides([{ ...post, title: "다른 주제", tags: ["인기태그"] }]),
    ).toEqual([]);
  });
  it("reads every public query page beyond 100 without accessing private stores", () => {
    service.listPostPage.mockImplementation(({ page }) => ({
      posts: [{ ...post, id: `page-${page}` }],
      total: 201,
      page,
      pageSize: 100,
      pageCount: 3,
    }));
    expect(
      listResourcePosts({ tag: "Ghidra", q: "분석" }).map((value) => value.id),
    ).toEqual(["page-1", "page-2", "page-3"]);
    expect(service.listPostPage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        page: 3,
        pageSize: 100,
        tag: "Ghidra",
        query: "분석",
      }),
    );
  });
  it("does not auto-curate a future public post even when its topic matches", () => {
    expect(resourceGuides([post])).toEqual([]);
    expect(resourceGuides([post], [post.id])[0].count).toBe(1);
  });
  it("honors an explicit current selection with optional guide mapping", () => {
    const matching = { ...post, title: "Ghidra 학습" };
    expect(
      resourceGuides([matching], new Map([[post.id, ["executables"]]])).map(
        (guide) => guide.slug,
      ),
    ).toEqual(["executables"]);
    expect(resourceGuides([matching], new Map())).toEqual([]);
  });
});
