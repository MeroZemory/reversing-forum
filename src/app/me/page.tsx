import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { SearchParams } from "@/contracts/screens";
import { loadMyPostsScreen } from "@/server/screens";
import { MyPostsScreen } from "@/components/screens/my-posts-screen";
export const metadata: Metadata = {
  title: "내 글",
  robots: { index: false, follow: false },
};

export default async function MyPosts({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const result = await loadMyPostsScreen(await searchParams);
  if (result.kind === "redirect") redirect(result.href);
  return <MyPostsScreen data={result.data} />;
}
