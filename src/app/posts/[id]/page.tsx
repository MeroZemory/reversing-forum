import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import { getViewer } from "@/server/auth";
import { getPost, listComments } from "@/server/forum";
import { formatDate, siteUrl } from "@/lib/format";
import { CommentSection } from "@/components/comment-section";
import { KindBadge } from "@/components/ui/kind-badge";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const viewer = await getViewer();
  const post = getPost(id, viewer?.id);
  if (!post)
    return { title: "글을 찾을 수 없습니다", robots: { index: false } };
  if (post.status !== "published")
    return {
      title: "공개 전 확인 중",
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

export default async function PostPage({ params }: Props) {
  const { id } = await params;
  const viewer = await getViewer();
  const post = getPost(id, viewer?.id);
  if (!post) notFound();
  const published = post.status === "published";
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
      <Link className="back-link" href={published ? "/" : "/me"}>
        <ArrowLeft size={16} />
        {published ? "커뮤니티로 돌아가기" : "내 글로 돌아가기"}
      </Link>
      {!published && (
        <div className="private-notice">
          <LockKeyhole size={20} />
          <div>
            <strong>공개 전 확인이 필요합니다.</strong>
            <p>
              현재는 작성자만 이 글을 볼 수 있습니다. 공개 전 확인을 마친 글만
              커뮤니티에 표시됩니다.
            </p>
          </div>
        </div>
      )}
      <article className="article">
        <KindBadge kind={post.kind} />
        <h1>{post.title}</h1>
        <div className="article-meta">
          <span className="avatar">{post.author.name.slice(0, 1)}</span>
          <strong>{post.author.name}</strong>
          <span>·</span>
          <time dateTime={post.createdAt}>{formatDate(post.createdAt)}</time>
        </div>
        <div className="article-body">{post.body}</div>
        {post.tags.length > 0 && (
          <div className="article-tags">
            {post.tags.map((tag) => (
              <Link
                className="tag"
                key={tag}
                href={`/?q=${encodeURIComponent(tag)}`}
              >
                #{tag}
              </Link>
            ))}
          </div>
        )}
      </article>
      {published && (
        <CommentSection postId={id} comments={comments} viewer={viewer} />
      )}
    </div>
  );
}
