import { getViewer } from "@/server/auth";
import { createComment } from "@/server/forum";
import { checkOrigin, failure, json, readJson } from "@/server/http";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    checkOrigin(request);
    const viewer = await getViewer();
    if (!viewer) return json({ error: "로그인이 필요합니다." }, 401);
    const { id } = await context.params;
    return json(createComment(viewer, id, await readJson(request)), 201);
  } catch (error) {
    return failure(error);
  }
}
