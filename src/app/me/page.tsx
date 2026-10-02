import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { getViewer } from "@/server/auth";
import { listMyPosts } from "@/server/forum";
import { formatDate } from "@/lib/format";
import { ActionLink } from "@/components/ui/action";
import { KindBadge } from "@/components/ui/kind-badge";
import { FeedScrollRestoration, PostLink } from "@/components/feed-navigation";
import {
  StatusBadge,
  statusLabels,
  statusDescriptions,
} from "@/components/ui/status-badge";
import type { PostStatus } from "@/lib/types";

export const metadata: Metadata = {
  title: "내 글",
  robots: { index: false, follow: false },
};

export default async function MyPosts({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { status: requestedStatus } = await searchParams;
  const statuses: PostStatus[] = ["published", "pending", "held"];
  const status = statuses.find((value) => value === requestedStatus);
  const returnPath = status ? `/me?status=${status}` : "/me";
  const viewer = await getViewer();
  if (!viewer) redirect(`/login?returnTo=${encodeURIComponent(returnPath)}`);
  const posts = listMyPosts(viewer.id);
  const counts = { published: 0, pending: 0, held: 0 };
  for (const post of posts) counts[post.status] += 1;
  const visiblePosts = status
    ? posts.filter((post) => post.status === status)
    : posts;
  return (
    <div className="shell my-posts-shell">
      <FeedScrollRestoration href={returnPath} />
      <div className="page-header">
        <div>
          <h1>내가 쓴 글</h1>
        </div>
        <ActionLink
          size="compact"
          href={`/new?from=${encodeURIComponent(returnPath)}`}
        >
          <Plus size={16} aria-hidden="true" /> 글 쓰기
        </ActionLink>
      </div>
      <p className="page-intro">
        내가 쓴 글의 공개 상태를 확인하세요. 공개 전 확인·공개 보류 글은 나만 볼
        수 있습니다.
      </p>
      <nav className="filter-tabs" aria-label="내 글 공개 상태">
        <Link
          href="/me"
          className={!status ? "active" : undefined}
          aria-current={!status ? "page" : undefined}
          scroll={false}
        >
          전체 <span>{posts.length}</span>
        </Link>
        {statuses.map((value) => (
          <Link
            key={value}
            href={`/me?status=${value}`}
            className={status === value ? "active" : undefined}
            aria-current={status === value ? "page" : undefined}
            scroll={false}
          >
            {statusLabels[value]} <span>{counts[value]}</span>
          </Link>
        ))}
      </nav>
      {(status || counts.held > 0) && (
        <div className="status-summary">
          {status ? (
            <p>{statusDescriptions[status]}</p>
          ) : (
            <p>공개 보류 글은 자동으로 재확인되지 않습니다.</p>
          )}
        </div>
      )}
      <div className="my-posts-list">
        {visiblePosts.length ? (
          visiblePosts.map((post) => (
            <PostLink
              className="my-post-row"
              key={post.id}
              id={post.id}
              title={post.title}
              from={returnPath}
            >
              <div>
                <KindBadge kind={post.kind} />
                <h2>{post.title}</h2>
                <time dateTime={post.createdAt}>
                  {formatDate(post.createdAt)}
                </time>
              </div>
              <StatusBadge status={post.status} />
            </PostLink>
          ))
        ) : (
          <div className="empty-state">
            <h2>
              {posts.length
                ? `${status ? statusLabels[status] : "선택한 상태"} 글이 없습니다.`
                : "아직 남긴 글이 없습니다."}
            </h2>
            <p>
              {posts.length
                ? "다른 상태를 선택하거나 전체 글을 확인해 주세요."
                : "궁금한 점이나 분석한 내용을 글로 남겨 보세요."}
            </p>
            {posts.length > 0 && (
              <ActionLink href="/me" variant="secondary">
                전체 내 글 보기
              </ActionLink>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
