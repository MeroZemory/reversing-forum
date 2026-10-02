import type { Metadata } from "next";
import { AccountFlow } from "@/features/account-flow";
export const metadata: Metadata = { robots: { index: false, follow: false } };
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    verified?: string;
    returnTo?: string;
  }>;
}) {
  const { error, verified, returnTo } = await searchParams;
  return (
    <AccountFlow
      mode="verify"
      error={error}
      verified={verified === "1"}
      returnTo={returnTo}
    />
  );
}
