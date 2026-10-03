import type { Metadata } from "next";
import { CommunityGuideScreen } from "@/components/screens/community-guide-screen";
import { canReviewReports } from "@/server/reports";
export const metadata: Metadata = {
  title: "운영 안내",
  alternates: { canonical: "/guide" },
};
export default async function Guide() {
  return <CommunityGuideScreen operator={await canReviewReports()} />;
}
