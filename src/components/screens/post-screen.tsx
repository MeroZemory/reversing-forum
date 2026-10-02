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
import { EditorialAuthor } from "../ui/editorial-author";
import { authorDisplayName } from "@/lib/editorial-labels";

export function PostScreen({
  data,
  commentsSlot,
}: {
  data: PostScreenData;
  commentsSlot: ReactNode;
}) {
  const { post, comments, returnTo, fromMyPosts } = data;
  const published = post.status === "published";
  const authorName = authorDisplayName(post.author, data.locale);
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "DiscussionForumPosting",
    headline: post.title,
    text: post.body,
    datePublished: post.createdAt,
    author: {
      "@type": post.author.role === "editor" ? "Organization" : "Person",
      name: authorName,
    },
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
            {authorName.slice(0, 1)}
          </span>
          <strong>
            <EditorialAuthor author={post.author} locale={data.locale} />
          </strong>
          <span>·</span>
          <time dateTime={post.createdAt}>{formatDate(post.createdAt)}</time>
        </div>
        {post.editorial && (
          <aside
            className="editorial-provenance"
            aria-label="자료 출처와 확인 상태"
          >
            <p>
              <strong>자료 출처</strong> ·{" "}
              {post.editorial.sourceType === "chat-editorial"
                ? "과거 카톡의 기술 논의를 정리한 편집 자료입니다."
                : "편집 계정이 별도로 작성한 안내 자료입니다."}
            </p>
            <p>
              {post.editorial.sourceType === "chat-editorial"
                ? "과거 기록 기간"
                : "자료 기준 기간"}{" "}
              · {post.editorial.period || "기간 미확인"}
            </p>
            <p>
              <strong>현재 확인 상태</strong> ·{" "}
              {post.editorial.verificationSummary.trim() ||
                "확인 상태가 기록되지 않았습니다."}
            </p>
            <p>기록 기간과 웹 게시일은 별도로 표시합니다.</p>
          </aside>
        )}
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
