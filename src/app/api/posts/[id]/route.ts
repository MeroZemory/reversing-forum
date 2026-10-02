import { getViewer } from "@/server/auth";
import { getPost, listComments } from "@/server/forum";
import { json } from "@/server/http";
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
