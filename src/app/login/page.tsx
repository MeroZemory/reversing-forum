import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { SearchParams } from "@/contracts/screens";
import { loadAuthScreen } from "@/server/screens";
import { AuthForm } from "@/features/auth-form";
import { AuthScreen } from "@/components/screens/auth-screen";
export const metadata: Metadata = {
  title: "로그인",
  robots: { index: false, follow: false },
};

export default async function AuthPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const result = await loadAuthScreen("login", await searchParams);
  if (result.kind === "redirect") redirect(result.href);
  return <AuthScreen form={<AuthForm {...result.data} />} />;
}
