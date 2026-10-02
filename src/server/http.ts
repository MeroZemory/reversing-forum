import "server-only";
import { ForumError } from "./forum";

export function checkOrigin(request: Request) {
  const expected = new URL(process.env.BETTER_AUTH_URL!).origin;
  if (
    request.headers.get("origin") !== expected ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new ForumError(403, "같은 사이트에서 요청해 주세요.");
}
export async function readJson(request: Request): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .endsWith("application/json")
  )
    throw new ForumError(415, "JSON 요청이 필요합니다.");
  // Bound bytes even when Content-Length is absent or dishonest.
  const reader = request.body?.getReader();
  if (!reader) throw new ForumError(400, "요청 본문이 필요합니다.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 160_000) {
      await reader.cancel();
      throw new ForumError(413, "요청이 너무 큽니다.");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ForumError(400, "올바른 JSON을 입력해 주세요.");
  }
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export function failure(error: unknown): Response {
  return error instanceof ForumError
    ? json({ error: error.message }, error.status)
    : json({ error: "요청을 처리하지 못했습니다." }, 500);
}
