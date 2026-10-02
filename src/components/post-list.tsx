import Link from "next/link";
import { FileCode2, MessageSquare } from "lucide-react";
import { formatDate } from "@/lib/format";
import { purposeLabels, type PostSummary } from "@/lib/types";
import { type FeedFilters } from "@/lib/feed-navigation";
import { PostLink } from "./feed-navigation";
import { KindBadge } from "./ui/kind-badge";
import { TopicLink } from "./ui/topic-link";
import { EditorialAuthor } from "./ui/editorial-author";
import { authorDisplayName } from "@/lib/editorial-labels";

export function PostList({
  posts,
  filters = {},
  from = "/",
  locale = "ko",
}: {
  posts: PostSummary[];
  filters?: FeedFilters;
  from?: string;
  locale?: string;
}) {
  const { purpose, query, tag } = filters;
  if (posts.length === 0)
    return (
      <div className="forum-empty" role="status">
        <FileCode2
          className="forum-empty-icon"
          size={28}
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <div className="forum-empty-body">
          <h2>
            {query
              ? "검색어에 맞는 글이 없습니다."
              : tag
                ? `아직 ${tag} 주제의 공개 글이 없습니다.`
                : purpose
                  ? `아직 공개된 ${purposeLabels[purpose]} 글이 없습니다.`
                  : "아직 공개된 글이 없습니다."}
          </h2>
          <p>
            {query || tag || purpose
              ? "검색어를 지우거나 다른 목적·주제의 글을 확인해 보세요."
              : "궁금했던 점이나 분석하며 발견한 내용을 첫 글로 남겨 주세요."}
          </p>
          {(purpose || tag) && (
            <Link href="/" scroll={false}>
              {query || (purpose && tag) ? "모든 조건 지우기" : "전체 글 보기"}
            </Link>
          )}
        </div>
      </div>
    );
  return (
    <div className="forum-posts">
      <table className="forum-table">
        <caption className="sr-only">게시글 목록</caption>
        <thead>
          <tr>
            <th scope="col">글</th>
            <th scope="col">작성자 · 작성일</th>
            <th scope="col">댓글</th>
          </tr>
        </thead>
        <tbody>
          {posts.map((post) => (
            <tr className="forum-post-row" key={post.id}>
              <td className="forum-post-title">
                <div className="post-title-line">
                  <KindBadge kind={post.kind} />
                  <PostLink id={post.id} title={post.title} from={from} />
                </div>
                {post.tags.length > 0 && (
                  <div className="post-topics">
                    {post.tags.slice(0, 3).map((topic) => (
                      <TopicLink key={topic} tag={topic} compact />
                    ))}
                    {post.tags.length > 3 && (
                      <span className="topic-overflow">
                        +{post.tags.length - 3}
                      </span>
                    )}
                  </div>
                )}
              </td>
              <td className="forum-post-author">
                <span
                  className="post-author-name"
                  title={authorDisplayName(post.author, locale)}
                >
                  <span className="sr-only">작성자 </span>
                  <EditorialAuthor author={post.author} locale={locale} />
                </span>
                <time dateTime={post.createdAt}>
                  {formatDate(post.createdAt)}
                </time>
              </td>
              <td className="forum-post-comments">
                <MessageSquare size={14} aria-hidden="true" />
                <span aria-label={`댓글 ${post.commentCount}개`}>
                  {post.commentCount}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
