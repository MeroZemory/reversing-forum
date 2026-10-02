import { afterEach, describe, expect, it, vi } from "vitest";
import { createComment, createPost } from "@/client/forum-client";
import type { CreatePostCommand } from "@/lib/interaction-types";
import type { Comment } from "@/lib/types";

const post: CreatePostCommand = {
  title: "Example title",
  body: "Example post body",
  kind: "discussion",
  tags: [],
};
const comment: Comment = {
  id: "comment-id",
  postId: "post-id",
  parentId: null,
  author: { id: "author-id", name: "Author" },
  body: "Example comment",
  createdAt: "2026-10-02T00:00:00.000Z",
};

function respond(value: unknown, status = 201) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json(value, { status })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("forum client response contracts", () => {
  it.each([
    [201, "published"],
    [202, "held"],
    [202, "pending"],
  ])(
    "accepts %s with %s status as a saved post",
    async (httpStatus, status) => {
      const result = { id: "saved-post", status };
      respond(result, httpStatus as number);
      await expect(createPost(post)).resolves.toEqual({
        ok: true,
        data: result,
      });
    },
  );

  it("preserves 401 status and server message without applying success validation", async () => {
    respond({ error: "로그인이 필요합니다." }, 401);
    await expect(createPost(post)).resolves.toEqual({
      ok: false,
      status: 401,
      error: "로그인이 필요합니다.",
    });
  });

  it.each([
    null,
    {},
    { id: "", status: "held" },
    { id: "   ", status: "pending" },
    { id: 123, status: "published" },
    { id: "saved-post", status: "unknown" },
  ])("rejects malformed successful post payload %j", async (payload) => {
    respond(payload, 202);
    await expect(createPost(post)).rejects.toThrow(
      "Invalid successful response payload.",
    );
  });

  it("rejects invalid JSON and transport failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("invalid JSON", { status: 201 })),
    );
    await expect(createPost(post)).rejects.toThrow();
    const failure = new Error("Disconnected");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    await expect(createPost(post)).rejects.toBe(failure);
  });

  it("encodes the comment post ID as one path segment and accepts a valid comment", async () => {
    const postId = "post/한글?from=x#comments";
    const result = { ...comment, postId };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json(result, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createComment(postId, { body: comment.body, parentId: null }),
    ).resolves.toEqual({ ok: true, data: result });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/posts/${encodeURIComponent(postId)}/comments`,
    );
  });

  it("accepts a valid reply", async () => {
    const result = { ...comment, parentId: "parent-id" };
    respond(result);
    await expect(
      createComment(comment.postId, {
        body: comment.body,
        parentId: "parent-id",
      }),
    ).resolves.toEqual({ ok: true, data: result });
  });

  it.each([
    {},
    { ...comment, id: "" },
    { ...comment, postId: null },
    { ...comment, parentId: 1 },
    { ...comment, parentId: undefined },
    { ...comment, author: null },
    { ...comment, author: { id: "author-id" } },
    { ...comment, author: { id: "", name: "Author" } },
    { ...comment, body: 1 },
    { ...comment, createdAt: null },
  ])("rejects malformed successful comment payload %j", async (payload) => {
    respond(payload);
    await expect(
      createComment(comment.postId, { body: comment.body, parentId: null }),
    ).rejects.toThrow("Invalid successful response payload.");
  });
});
