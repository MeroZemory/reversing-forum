import { getViewer } from "@/server/auth";
import { getPost, listComments, updatePost } from "@/server/forum";
import { checkOrigin, failure, json, readJson } from "@/server/http";
export const runtime = "nodejs";
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const viewer = await getViewer();
  const post = getPost(id, viewer?.id);
  return post
    ? json({ post, comments: listComments(id) })
    : json({ error: "글을 찾을 수 없습니다." }, 404);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    checkOrigin(request);
    const viewer = await getViewer();
    if (!viewer) return json({ error: "로그인이 필요합니다." }, 401);
    const { id } = await context.params;
    const result = await updatePost(viewer, id, await readJson(request));
    return json(result, result.status === "published" ? 200 : 202);
  } catch (error) {
    return failure(error);
  }
}
