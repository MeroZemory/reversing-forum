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
import { PostLink } from "../feed-navigation";
import { authorDisplayName } from "@/lib/editorial-labels";

export function PostScreen({
  data,
  commentsSlot,
  retrySlot,
}: {
  data: PostScreenData;
  commentsSlot: ReactNode;
  retrySlot?: ReactNode;
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
          {data.publicationNotice && (
            <>
              <p>
                {data.publicationNotice.reason === "duplicate"
                  ? "기존 글과 비교했을 때 새 정보가 확인되지 않아 공개가 보류됐습니다. 관련 글을 확인해 주세요."
                  : data.publicationNotice.reason === "busy"
                    ? "다른 글을 확인하고 있습니다. 잠시 후 다시 확인할 수 있습니다."
                    : data.publicationNotice.reason === "size"
                      ? "글이 너무 길어 전체 내용을 확인하지 못했습니다."
                      : data.publicationNotice.reason === "attempt-limit"
                        ? "이 글의 다시 확인 요청 한도에 도달했습니다. 현재는 공개되지 않습니다."
                        : data.publicationNotice.reason === "screening"
                          ? "기본 확인에서 공개를 보류했습니다."
                          : "확인이 끝나지 않았습니다. 내용은 비공개로 유지됩니다."}
              </p>
              {data.publicationNotice.relatedPosts.length > 0 && (
                <ul>
                  {data.publicationNotice.relatedPosts.map((item) => (
                    <li key={item.id}>
                      <PostLink id={item.id} title={item.title} from="/" />
                    </li>
                  ))}
                </ul>
              )}
              {retrySlot}
            </>
          )}
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
              <TopicLink key={tag} tag={tag} from={returnTo} />
            ))}
          </div>
        )}
      </article>
      {published && (data.relatedPosts?.length ?? 0) > 0 && (
        <section className="related-posts" aria-labelledby="related-title">
          <h2 id="related-title">함께 읽을 글</h2>
          <ul>
            {data.relatedPosts!.map((item) => (
              <li key={item.id}>
                <PostLink id={item.id} title={item.title} from={returnTo} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {published && commentsSlot}
    </div>
  );
}
