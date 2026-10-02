import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { SearchParams } from "@/contracts/screens";
import { loadNewPostScreen } from "@/server/screens";
import { PostForm } from "@/features/post-form";
import { NewPostScreen } from "@/components/screens/new-post-screen";
export const metadata: Metadata = {
  title: "글 쓰기",
  robots: { index: false, follow: false },
};

export default async function NewPost({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const result = await loadNewPostScreen(await searchParams);
  if (result.kind === "redirect") redirect(result.href);
  return <NewPostScreen composer={<PostForm {...result.data} />} />;
}
