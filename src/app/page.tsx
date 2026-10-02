import type { Metadata } from "next";
import type { SearchParams } from "@/contracts/screens";
import { loadFeedScreen } from "@/server/screens";
import { readFeedFilters } from "@/lib/feed-navigation";
import { FeedScreen } from "@/components/screens/feed-screen";
type Props = { searchParams: Promise<SearchParams> };

export async function generateMetadata({
  searchParams,
}: Props): Promise<Metadata> {
  const filters = readFeedFilters(await searchParams);
  const filtered = !!(
    filters.purpose ||
    filters.tag ||
    filters.query ||
    (filters.page ?? 1) > 1
  );
  return {
    alternates: { canonical: "/" },
    ...(filtered
      ? { title: "글 찾아보기", robots: { index: false, follow: true } }
      : {}),
  };
}
export default async function Home({ searchParams }: Props) {
  return <FeedScreen data={loadFeedScreen(await searchParams)} />;
}
