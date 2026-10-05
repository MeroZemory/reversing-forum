import Link from "next/link";
import { Fragment } from "react";
import { formatDate } from "@/lib/format";
import { getPostPurpose, purposeLabels, type PostSummary } from "@/lib/types";
import type { FeedFilters } from "@/lib/feed-navigation";
import { canonicalTopic } from "@/lib/topic-aliases";
import { PostLink } from "./feed-navigation";
import { TopicLink } from "./ui/topic-link";
import { AnswerLink } from "./header-search";
import styles from "./community-layout.module.css";

// Literal matching produces React text nodes, including for HTML and regexp input.
export function HighlightText({
  text,
  query,
}: {
  text: string;
  query?: string;
}) {
  if (!query) return <>{text}</>;
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  const nodes = [];
  let start = 0;
  let match = haystack.indexOf(needle);
  while (match >= 0) {
    nodes.push(
      <Fragment key={start}>
        {text.slice(start, match)}
        <mark>{text.slice(match, match + query.length)}</mark>
      </Fragment>,
    );
    start = match + query.length;
    match = haystack.indexOf(needle, start);
  }
  return (
    <>
      {nodes}
      {text.slice(start)}
    </>
  );
}
export function PostRow({
  post,
  from,
  query,
  answer = false,
}: {
  post: PostSummary;
  from: string;
  query?: string;
  answer?: boolean;
}) {
  const purpose = getPostPurpose(post.kind);
  const topics = [...new Set(post.tags.map(canonicalTopic))];
  const at = query
    ? post.excerpt.toLowerCase().indexOf(query.toLowerCase())
    : -1;
  const preview = at > 60 ? "…" + post.excerpt.slice(at - 40) : post.excerpt;
  return (
    <li className={answer ? styles.answerRow : styles.row}>
      <div className={styles.rowTop}>
        <span className={styles.purpose} data-purpose={purpose}>
          {purposeLabels[purpose]}
        </span>
        {purpose === "question" && (
          <span className={styles.state}>
            {post.commentCount === 0
              ? "답 기다림"
              : `답변 ${post.commentCount}`}
          </span>
        )}
      </div>
      <h2 className={styles.rowTitle}>
        <PostLink
          className={styles.titleLink}
          id={post.id}
          title={post.title}
          from={from}
        >
          <HighlightText text={post.title} query={query} />
        </PostLink>
      </h2>
      <p className={styles.preview}>
        <HighlightText text={preview} query={query} />
      </p>
      <div className={styles.rowMeta}>
        {post.recordPeriod ? (
          <span>{post.recordPeriod} 카톡 기록</span>
        ) : post.author.role !== "editor" ? (
          <>
            <span>{post.author.name}</span>
            <time dateTime={post.createdAt}>{formatDate(post.createdAt)}</time>
          </>
        ) : (
          <span>편집 자료</span>
        )}
        {topics.slice(0, 3).map((topic) => (
          <TopicLink key={topic} tag={topic} from={from} compact />
        ))}
        {topics.length > 3 && <span>+{topics.length - 3}</span>}
        {!!post.sourceCount && <span>보충 출처 {post.sourceCount}</span>}
        {purpose !== "question" && post.commentCount > 0 && (
          <span>댓글 {post.commentCount}</span>
        )}
      </div>
      {answer && (
        <div className={styles.rowAction}>
          <AnswerLink id={post.id} from={from} className={styles.answerLink} />
        </div>
      )}
    </li>
  );
}
export function PostList({
  posts,
  filters = {},
  from = "/",
  basePath = "/",
  answer = false,
}: {
  posts: PostSummary[];
  filters?: FeedFilters;
  from?: string;
  locale?: string;
  basePath?: string;
  answer?: boolean;
}) {
  const { purpose, query, tag } = filters;
  if (!posts.length)
    return (
      <div className={styles.empty} role="status">
        <h2>
          {query
            ? "검색어에 맞는 글이 없습니다."
            : tag
              ? `아직 ${canonicalTopic(tag)} 주제의 공개 글이 없습니다.`
              : answer
                ? "답을 기다리는 질문이 없습니다."
                : purpose
                  ? `아직 공개된 ${purposeLabels[purpose]} 글이 없습니다.`
                  : "아직 공개된 글이 없습니다."}
        </h2>
        <p>
          {query || tag || purpose
            ? "검색어를 지우거나 다른 목적·주제의 글을 확인해 보세요."
            : "궁금했던 점이나 분석하며 발견한 내용을 첫 글로 남겨 주세요."}
        </p>
        {query && (
          <Link
            href={`/new?purpose=question&title=${encodeURIComponent(query)}`}
          >
            ‘{query}’로 질문하기
          </Link>
        )}
        {(query || purpose || tag) && (
          <Link href={basePath} scroll={false}>
            {query || (purpose && tag) ? "모든 조건 지우기" : "전체 글 보기"}
          </Link>
        )}
        {query && <Link href="/resources">모든 주제</Link>}
      </div>
    );
  return (
    <ul className={styles.postList} aria-label="게시글 목록">
      {posts.map((post) => (
        <PostRow
          key={post.id}
          post={post}
          from={from}
          query={query}
          answer={answer}
        />
      ))}
    </ul>
  );
}
