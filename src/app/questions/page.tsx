import type { Metadata } from "next";
import type { SearchParams } from "@/contracts/screens";
import { loadFeedScreen } from "@/server/screens";
import { FeedScreen } from "@/components/screens/feed-screen";

export const metadata: Metadata = {
  title: "답을 기다리는 질문",
  alternates: { canonical: "/questions" },
  robots: { index: false, follow: true },
};

export default async function Questions({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  return (
    <FeedScreen
      data={loadFeedScreen(
        { ...params, purpose: "question" },
        { basePath: "/questions", open: true, title: "답을 기다리는 질문" },
      )}
    />
  );
}
