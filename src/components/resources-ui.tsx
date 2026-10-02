import Link from "next/link";
import type { PostSummary } from "@/lib/types";
import { listHref } from "@/lib/resource-navigation";
import { formatDate } from "@/lib/format";
import { EditorialAuthor } from "./ui/editorial-author";
import { KindBadge } from "./ui/kind-badge";
import { PostLink } from "./feed-navigation";

export function SiteEntrances({ active }: { active: "feed" | "resources" }) {
  return (
    <nav className="site-entrances" aria-label="사이트 둘러보기">
      <Link href="/" aria-current={active === "feed" ? "page" : undefined}>
        최신 글
      </Link>
      <Link
        href="/resources"
        aria-current={active === "resources" ? "page" : undefined}
      >
        자료 길잡이
      </Link>
    </nav>
  );
}

export function ResourcePostList({
  posts,
  from,
  basePath,
}: {
  posts: PostSummary[];
  from: string;
  basePath: string;
}) {
  if (!posts.length)
    return (
      <div className="forum-empty" role="status">
        <div>
          <h2>조건에 맞는 공개 글이 없습니다.</h2>
          <p>검색어 또는 주제 조건을 바꿔 보세요.</p>
          <Link href={basePath}>모든 조건 지우기</Link>
        </div>
      </div>
    );
  return (
    <ul className="resource-posts">
      {posts.map((post) => (
        <li key={post.id}>
          <div className="post-title-line">
            <KindBadge kind={post.kind} />
            <PostLink id={post.id} title={post.title} from={from} />
          </div>
          <p className="resource-excerpt">{post.excerpt}</p>
          <div className="resource-post-meta">
            <EditorialAuthor author={post.author} />
            <time dateTime={post.createdAt}>{formatDate(post.createdAt)}</time>
            <span>댓글 {post.commentCount}개</span>
          </div>
          <div className="post-topics">
            {post.tags.map((tag) => (
              <Link
                key={tag}
                className="topic-inline"
                href={listHref(basePath, { tag })}
                aria-label={`${tag} 주제 글 보기`}
              >
                #{tag}
              </Link>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}
