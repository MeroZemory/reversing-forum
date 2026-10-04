import type {
  CreatePostCommand,
  CreatePostResult,
  EditPostCommand,
  CreateCommentCommand,
} from "@/lib/interaction-types";
import type { Comment } from "@/lib/types";
type WriteResult<T> =
  { ok: true; data: T } | { ok: false; status: number; error?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPostResult(value: unknown): value is CreatePostResult {
  return (
    isRecord(value) &&
    isId(value.id) &&
    (value.status === "pending" ||
      value.status === "published" ||
      value.status === "held")
  );
}

function isComment(value: unknown): value is Comment {
  return (
    isRecord(value) &&
    isId(value.id) &&
    isId(value.postId) &&
    (value.parentId === null || isId(value.parentId)) &&
    isRecord(value.author) &&
    isId(value.author.id) &&
    typeof value.author.name === "string" &&
    typeof value.body === "string" &&
    typeof value.createdAt === "string"
  );
}

async function writeJson<T>(
  url: string,
  command: unknown,
  isValid: (value: unknown) => value is T,
  method: "POST" | "PATCH" = "POST",
): Promise<WriteResult<T>> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const data: unknown = await response.json();
  if (!response.ok)
    return {
      ok: false,
      status: response.status,
      error:
        isRecord(data) && typeof data.error === "string"
          ? data.error
          : undefined,
    };
  if (!isValid(data)) throw new Error("Invalid successful response payload.");
  return { ok: true, data };
}
export const createPost = (command: CreatePostCommand) =>
  writeJson("/api/posts", command, isPostResult);
export const editPost = (postId: string, command: EditPostCommand) =>
  writeJson(
    `/api/posts/${encodeURIComponent(postId)}`,
    command,
    isPostResult,
    "PATCH",
  );
export const retryPost = (postId: string) =>
  writeJson(`/api/posts/${encodeURIComponent(postId)}/retry`, {}, isPostResult);
export const reviewPost = (postId: string) =>
  writeJson(
    `/api/posts/${encodeURIComponent(postId)}/review`,
    {},
    isPostResult,
  );
export const createComment = (postId: string, command: CreateCommentCommand) =>
  writeJson(
    `/api/posts/${encodeURIComponent(postId)}/comments`,
    command,
    isComment,
  );
