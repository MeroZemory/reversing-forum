import type { Metadata } from "next";
import type { PostDetail } from "@/lib/types";
import { statusLabels } from "../ui/status-badge";
export function postMetadata(post: PostDetail | null): Metadata {
  if (!post)
    return { title: "글을 찾을 수 없습니다", robots: { index: false } };
  if (post.status !== "published")
    return {
      title: statusLabels[post.status],
      robots: { index: false, follow: false },
    };
  return {
    title: post.title,
    description: post.excerpt,
    alternates: { canonical: `/posts/${post.id}` },
    openGraph: {
      type: "article",
      title: post.title,
      description: post.excerpt,
      publishedTime: post.createdAt,
      authors: [post.author.name],
    },
  };
}
