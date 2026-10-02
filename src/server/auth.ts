import "server-only";
import { headers } from "next/headers";
import type { Viewer } from "@/lib/types";
import { auth } from "./auth-config";
export { auth };

export async function getViewer(): Promise<Viewer | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session
    ? {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      }
    : null;
}
