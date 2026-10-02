import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { SearchParams } from "@/contracts/screens";
import { loadPostDocument, loadPostScreen } from "@/server/screens";
import { getPostPurpose } from "@/lib/types";
import { CommentSection } from "@/features/comment-section";
import { PostScreen } from "@/components/screens/post-screen";
import { postMetadata } from "@/components/screens/post-metadata";
type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return postMetadata((await loadPostDocument((await params).id)).post);
}
export default async function PostPage({ params, searchParams }: Props) {
  const { id } = await params;
  const data = await loadPostScreen(id, await searchParams);
  if (!data) notFound();
  const commentsSlot =
    data.post.status === "published" ? (
      <CommentSection
        postId={id}
        postPath={data.postPath}
        purpose={getPostPurpose(data.post.kind)}
        comments={data.comments}
        viewer={data.viewer}
      />
    ) : null;
  return <PostScreen data={data} commentsSlot={commentsSlot} />;
}
