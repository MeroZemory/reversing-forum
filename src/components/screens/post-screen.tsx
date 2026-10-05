import type { ReactNode } from "react";
import Link from "next/link";
import type { PostScreenData } from "@/contracts/screens";
import { formatDate } from "@/lib/format";
import { getPostPurpose } from "@/lib/types";
import { canonicalTopic } from "@/lib/topic-aliases";
import { bodyHeadings, bodySections } from "@/lib/markdown-structure";
import { authorDisplayName } from "@/lib/editorial-labels";
import { KindBadge } from "../ui/kind-badge";
import { TopicLink } from "../ui/topic-link";
import { Notice } from "../ui/notice";
import { statusLabels, statusDescriptions } from "../ui/status-badge";
import { MarkdownBody } from "../markdown-body";
import { ListReturnLink, PostLink } from "../feed-navigation";
import { EditorialAuthor } from "../ui/editorial-author";
import { ProvenanceToggle } from "../provenance-toggle";
import { PostShare } from "../post-share";
import styles from "../post-reading.module.css";

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
  const question = getPostPurpose(post.kind) === "question";
  const authorName = authorDisplayName(post.author, data.locale);
  const headings = bodyHeadings(post.body);
  const hasToc = headings.length >= 3;
  const topics = [...new Set(post.tags.map(canonicalTopic))];
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
  const toc = (
    <ol>
      {headings.map((heading) => (
        <li key={heading.id}>
          <a href={`#${heading.id}`}>{heading.text}</a>
        </li>
      ))}
    </ol>
  );
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
      <div className={`${styles.layout} ${hasToc ? styles.withToc : ""}`}>
        <div className={styles.main}>
          <ListReturnLink
            href={returnTo}
            privatePost={!published || fromMyPosts}
          />
          {!published && (
            <Notice tone="warning" title={statusLabels[post.status]}>
              {statusDescriptions[post.status]}
              {data.publicationNotice && (
                <>
                  <p>
                    {data.publicationNotice.reason === "duplicate"
                      ? "기존 글과 비교해 새 정보가 확인되지 않아 공개를 보류했어요. 관련 글을 확인해 주세요."
                      : data.publicationNotice.reason === "busy"
                        ? "다른 글을 확인하고 있어요. 잠시 후 다시 확인할 수 있어요."
                        : data.publicationNotice.reason === "size"
                          ? "글이 너무 길어 전체 내용을 확인하지 못했어요."
                          : data.publicationNotice.reason === "attempt-limit"
                            ? "다시 확인 요청 한도에 도달했어요. 현재는 공개되지 않아요."
                            : data.publicationNotice.reason === "screening"
                              ? "기본 확인에서 공개를 보류했어요."
                              : "확인이 끝나지 않았어요. 내용은 비공개로 유지돼요."}
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
          <article className={`article ${styles.article}`}>
            <div className={styles.heading}>
              <KindBadge kind={post.kind} />
              {published && question && (
                <a className={styles.answerState} href="#answers">
                  {comments.length ? `답변 ${comments.length}` : "○ 답 기다림"}
                </a>
              )}
            </div>
            <h1>{post.title}</h1>
            <div className={styles.meta}>
              {!post.editorial && (
                <span className="avatar" aria-hidden="true">
                  {authorName.slice(0, 1)}
                </span>
              )}
              <strong>
                <EditorialAuthor author={post.author} locale={data.locale} />
              </strong>
              <span>·</span>
              {post.editorial ? (
                <span>
                  {post.editorial.period || "기간 미확인"}
                  {post.editorial.sourceType === "chat-editorial"
                    ? " 카톡 기록"
                    : " 기준"}
                </span>
              ) : (
                <time dateTime={post.createdAt}>
                  {formatDate(post.createdAt)}
                </time>
              )}
              {data.editHref && <Link href={data.editHref}>수정</Link>}
            </div>
            {post.editorial && (
              <ProvenanceToggle
                provenance={post.editorial}
                createdAt={post.createdAt}
                postId={post.id}
                sourceCount={post.sourceCount}
                hasSupplement={bodySections(post.body).some(
                  (section) => section.supplement,
                )}
              />
            )}
            {hasToc && (
              <details className={styles.mobileToc}>
                <summary>목차 {headings.length}</summary>
                {toc}
              </details>
            )}
            <MarkdownBody body={post.body} editorial={!!post.editorial} />
            {topics.length > 0 && (
              <div className="article-tags">
                {topics.map((tag) => (
                  <TopicLink key={tag} tag={tag} from={returnTo} />
                ))}
              </div>
            )}
            {published && (
              <div className={styles.actions}>
                <PostShare url={data.publicUrl} />
                <Link href={`/report?post=${encodeURIComponent(post.id)}`}>
                  글 신고·삭제 요청
                </Link>
              </div>
            )}
          </article>
          {published && question && commentsSlot}
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
          {published && (data.sameTopicPosts?.length ?? 0) > 0 && (
            <section
              className={styles.sameTopic}
              aria-labelledby="same-topic-title"
            >
              <h2 id="same-topic-title">같은 주제의 글</h2>
              <ul>
                {data.sameTopicPosts!.map((item) => (
                  <li key={item.id}>
                    <PostLink id={item.id} title={item.title} from={returnTo} />
                    <p>{item.excerpt}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {published && !question && commentsSlot}
        </div>
        {hasToc && (
          <aside className={styles.toc}>
            <nav aria-label="목차">
              <h2>목차</h2>
              {toc}
            </nav>
          </aside>
        )}
      </div>
    </div>
  );
}
