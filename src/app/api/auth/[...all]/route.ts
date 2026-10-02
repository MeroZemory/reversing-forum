import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth";
import { checkOrigin, failure } from "@/server/http";
export const runtime = "nodejs";
const handler = toNextJsHandler(auth);
export const GET = handler.GET;
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    return await handler.POST(request);
  } catch (error) {
    return failure(error);
  }
}
