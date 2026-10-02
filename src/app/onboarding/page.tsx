import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewer } from "@/server/auth";
import { AccountFlow } from "@/features/account-flow";
import { safeAuthReturn } from "@/lib/format";
export const metadata: Metadata = { robots: { index: false, follow: false } };
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { returnTo } = await searchParams;
  const destination = safeAuthReturn(returnTo);
  const viewer = await getViewer();
  if (!viewer)
    redirect(
      `/login?returnTo=${encodeURIComponent(`/onboarding?returnTo=${encodeURIComponent(destination)}`)}`,
    );
  return <AccountFlow mode="onboarding" returnTo={destination} />;
}
