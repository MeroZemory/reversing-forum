import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { SearchParams } from "@/contracts/screens";
import { loadEditPostScreen } from "@/server/screens";
import { PostForm } from "@/features/post-form";
import { EditPostScreen } from "@/components/screens/edit-post-screen";

export const metadata: Metadata = {
  title: "글 수정",
  robots: { index: false, follow: false },
};

export default async function EditPost({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const result = await loadEditPostScreen(
    (await params).id,
    await searchParams,
  );
  if (!result) notFound();
  if (result.kind === "redirect") redirect(result.href);
  return (
    <EditPostScreen
      composer={
        <PostForm
          key={`${result.data.editing.id}:${result.data.editing.expectedHash}`}
          {...result.data}
        />
      }
    />
  );
}
