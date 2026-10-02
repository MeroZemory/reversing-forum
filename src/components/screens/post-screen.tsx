import type { ReactNode } from "react";
import { MessageSquare } from "lucide-react";
import type { PostScreenData } from "@/contracts/screens";
import { formatDate } from "@/lib/format";
import { KindBadge } from "../ui/kind-badge";
import { TopicLink } from "../ui/topic-link";
import { Notice } from "../ui/notice";
import { statusLabels, statusDescriptions } from "../ui/status-badge";
import { MarkdownBody } from "../markdown-body";
import { ListReturnLink } from "../feed-navigation";

export function PostScreen({
  data,
  commentsSlot,
}: {
  data: PostScreenData;
  commentsSlot: ReactNode;
}) {
  const { post, comments, returnTo, fromMyPosts } = data;
  const published = post.status === "published";
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "DiscussionForumPosting",
    headline: post.title,
    text: post.body,
    datePublished: post.createdAt,
    author: { "@type": "Person", name: post.author.name },
    url: data.publicUrl,
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
      {published && commentsSlot}
    </div>
  );
}
