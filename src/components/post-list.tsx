import Link from "next/link";
import { FileCode2 } from "lucide-react";
import { formatDate } from "@/lib/format";
import { kindLabels, type PostKind, type PostSummary } from "@/lib/types";
import { KindBadge } from "./ui/kind-badge";

export function PostList({
  posts,
  kind,
  query = "",
}: {
  posts: PostSummary[];
  kind?: PostKind;
  query?: string;
}) {
  if (posts.length === 0) {
    return (
      <div className="forum-empty" role="status">
        <FileCode2
          className="forum-empty-icon"
          size={24}
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <div className="forum-empty-body">
          <p>
            {query
              ? "검색어에 맞는 글이 없습니다."
              : kind
                ? `아직 공개된 ${kindLabels[kind]} 글이 없습니다.`
                : "아직 공개된 글이 없습니다."}
          </p>
          {kind || query ? (
            <>
              <span>검색어를 바꾸거나 다른 유형의 글을 확인해 보세요.</span>
              {kind && (
                <Link href="/" scroll={false}>
                  {query ? "모든 조건 지우기" : "전체 글 보기"}
                </Link>
              )}
            </>
          ) : (
            <span>
              질문이나 분석을 글로 남겨 주세요. 공개된 글은 여기에 모입니다.
            </span>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="forum-posts">
      <table className="forum-table">
        <caption className="sr-only">게시글 목록</caption>
        <thead>
          <tr>
            <th scope="col">유형</th>
            <th scope="col">제목</th>
            <th scope="col">작성자</th>
            <th scope="col">작성일</th>
            <th scope="col">댓글</th>
          </tr>
        </thead>
        <tbody>
          {posts.map((post) => (
            <tr className="forum-post-row" key={post.id}>
              <td className="forum-post-kind">
                <KindBadge kind={post.kind} />
              </td>
              <td className="forum-post-title">
                <Link href={`/posts/${post.id}`}>{post.title}</Link>
              </td>
              <td className="forum-post-author" title={post.author.name}>
                <span className="sr-only">작성자 </span>
                {post.author.name}
              </td>
              <td className="forum-post-date">
                <time dateTime={post.createdAt}>
                  {formatDate(post.createdAt)}
                </time>
              </td>
              <td className="forum-post-comments">
                <span className="forum-mobile-label">댓글 </span>
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
