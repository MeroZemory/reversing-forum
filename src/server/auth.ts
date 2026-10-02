import "server-only";
import { headers } from "next/headers";
import type { Viewer } from "@/lib/types";
import { auth } from "./auth-config";
import { GOOGLE_PLACEHOLDER, nicknameReady } from "./auth-policy";
export { auth };

export async function getViewer(): Promise<Viewer | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session
    ? {
        id: session.user.id,
        name: nicknameReady(session.user.id)
          ? session.user.name
          : GOOGLE_PLACEHOLDER,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        nicknameReady: nicknameReady(session.user.id),
      }
    : null;
}
