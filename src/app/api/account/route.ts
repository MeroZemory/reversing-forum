import { accountSnapshot, setInitialPassword } from "@/server/auth-account";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const account = await accountSnapshot(request.headers);
  return Response.json(account, {
    status: account ? 200 : 401,
    headers: { "Cache-Control": "no-store" },
  });
}
export async function POST(request: Request) {
  const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
  if (
    request.headers.get("origin") !== origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return Response.json(
      { error: "같은 사이트에서 요청해 주세요." },
      { status: 403 },
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return Response.json({ error: "JSON 요청이 필요합니다." }, { status: 415 });
  try {
    // Password payload is deliberately bounded before parsing.
    const reader = request.body?.getReader();
    if (!reader) throw new Error("요청 본문이 필요합니다.");
    let text = "";
    let size = 0;
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        throw new Error("요청이 너무 큽니다.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const body = JSON.parse(text);
    await setInitialPassword(request.headers, body.newPassword);
    return Response.json({ status: true });
  } catch {
    return Response.json(
      {
        error:
          "비밀번호를 설정하지 못했습니다. 10~128자를 입력하고 이메일 인증·최근 로그인·기존 비밀번호 여부를 확인해 주세요.",
      },
      { status: 400 },
    );
  }
}
