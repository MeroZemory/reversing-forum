import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MessageSquare } from "lucide-react";
import { getViewer } from "@/server/auth";
import { getPost, listComments } from "@/server/forum";
import { formatDate, siteUrl } from "@/lib/format";
import { CommentSection } from "@/components/comment-section";
import { KindBadge } from "@/components/ui/kind-badge";
import { TopicLink } from "@/components/ui/topic-link";
import { Notice } from "@/components/ui/notice";
import { statusLabels, statusDescriptions } from "@/components/ui/status-badge";
import { MarkdownBody } from "@/components/markdown-body";
import { ListReturnLink } from "@/components/feed-navigation";
import { safeFeedReturn, safeListReturn } from "@/lib/feed-navigation";
import { getPostPurpose } from "@/lib/types";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const viewer = await getViewer();
  const post = getPost(id, viewer?.id);
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

export default async function PostPage({ params, searchParams }: Props) {
  const { id } = await params;
  const viewer = await getViewer();
  const post = getPost(id, viewer?.id);
  if (!post) notFound();
  const published = post.status === "published";
  const { from: requestedFrom } = await searchParams;
  const from = typeof requestedFrom === "string" ? requestedFrom : undefined;
  const fromMyPosts =
    viewer?.id === post.author.id && !!from && /^\/me(?:\?|$)/.test(from);
  const returnTo =
    !published || fromMyPosts
      ? safeListReturn(from).startsWith("/me")
        ? safeListReturn(from)
        : "/me"
      : safeFeedReturn(from);
  const postPath = `/posts/${id}${from ? `?from=${encodeURIComponent(fromMyPosts ? returnTo : safeFeedReturn(from))}` : ""}`;
  const comments = published ? listComments(id) : [];
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "DiscussionForumPosting",
    headline: post.title,
    text: post.body,
    datePublished: post.createdAt,
    author: { "@type": "Person", name: post.author.name },
    url: `${siteUrl()}/posts/${post.id}`,
    commentCount: comments.length,
  };

  return (
    <div className="shell article-shell">
      {published && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
          }}
        />
      )}
      <ListReturnLink href={returnTo} privatePost={!published || fromMyPosts} />
      {!published && (
        <Notice tone="warning" title={statusLabels[post.status]}>
          {statusDescriptions[post.status]}
        </Notice>
      )}
      <article className="article">
        <div className="article-heading">
          <KindBadge kind={post.kind} />
          {published && (
            <a className="article-comment-link" href="#comments">
              <MessageSquare size={16} aria-hidden="true" />
              댓글 {comments.length}
            </a>
          )}
        </div>
        <h1>{post.title}</h1>
        <div className="article-meta">
          <span className="avatar" aria-hidden="true">
            {post.author.name.slice(0, 1)}
          </span>
          <strong>{post.author.name}</strong>
          <span>·</span>
          <time dateTime={post.createdAt}>{formatDate(post.createdAt)}</time>
        </div>
        <MarkdownBody body={post.body} />
        {post.tags.length > 0 && (
          <div className="article-tags">
            {post.tags.map((tag) => (
              <TopicLink key={tag} tag={tag} />
            ))}
          </div>
        )}
      </article>
      {published && (
        <CommentSection
          postId={id}
          postPath={postPath}
          purpose={getPostPurpose(post.kind)}
          comments={comments}
          viewer={viewer}
        />
      )}
    </div>
  );
}
