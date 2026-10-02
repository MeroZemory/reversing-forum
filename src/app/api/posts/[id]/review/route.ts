import { getViewer } from "@/server/auth";
import { requestPostDuplicateReview } from "@/server/forum";
import { checkOrigin, failure, json } from "@/server/http";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    checkOrigin(request);
    const viewer = await getViewer();
    if (!viewer) return json({ error: "로그인이 필요합니다." }, 401);
    const result = await requestPostDuplicateReview(viewer, (await params).id);
    return json(result, result.status === "published" ? 200 : 202);
  } catch (error) {
    return failure(error);
  }
}
