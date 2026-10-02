import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
import { redirect } from "next/navigation";
import { getViewer } from "@/server/auth";
import { safeAuthReturn } from "@/lib/format";

export const metadata: Metadata = {
  title: "로그인",
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const { returnTo } = await searchParams;
  const destination = safeAuthReturn(returnTo);
  if (await getViewer()) redirect(destination);
  return (
    <div className="shell auth-shell">
      <AuthForm mode="login" returnTo={destination} />
    </div>
  );
}
