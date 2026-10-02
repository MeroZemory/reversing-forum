import { googleConfigured, mailConfigured } from "@/server/auth-mail";
export const runtime = "nodejs";
export function GET() {
  return Response.json(
    { googleEnabled: googleConfigured(), mailEnabled: mailConfigured() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
