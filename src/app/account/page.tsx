import type { Metadata } from "next";
import { AccountFlow } from "@/features/account-flow";
export const metadata: Metadata = { robots: { index: false, follow: false } };
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return <AccountFlow mode="account" error={error} />;
}
