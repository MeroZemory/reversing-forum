import type { Metadata } from "next";
import { AccountFlow } from "@/features/account-flow";
export const metadata: Metadata = { robots: { index: false, follow: false } };
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  return <AccountFlow mode="reset" token={token} error={error} />;
}
