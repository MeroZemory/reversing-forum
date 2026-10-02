import { getViewer } from "@/server/auth";
import { createPost, listPosts } from "@/server/forum";
import { checkOrigin, failure, json, readJson } from "@/server/http";
import { postKinds, type PostKind } from "@/lib/types";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind") as PostKind | null;
  if (kind && !postKinds.includes(kind))
    return json({ error: "잘못된 글 종류입니다." }, 400);
  return json(
    listPosts({
      query: params.get("query") ?? undefined,
      kind: kind ?? undefined,
      limit: params.has("limit") ? Number(params.get("limit")) : undefined,
    }),
  );
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const viewer = await getViewer();
    if (!viewer) return json({ error: "로그인이 필요합니다." }, 401);
    const result = await createPost(viewer, await readJson(request));
    return json(result, result.status === "published" ? 201 : 202);
  } catch (error) {
    return failure(error);
  }
}
