import { accountSnapshot } from "@/server/auth-account";
export const runtime = "nodejs";
// Auth pages initialize for guests too. A missing session is a normal status,
// while protected account operations retain their authentication requirements.
export async function GET(request: Request) {
  return Response.json(await accountSnapshot(request.headers), {
    headers: { "Cache-Control": "no-store" },
  });
}
