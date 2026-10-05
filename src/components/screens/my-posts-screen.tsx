import Link from "next/link";
import { Plus } from "lucide-react";
import type { MyPostsScreenData } from "@/contracts/screens";
import type { PostStatus } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { ActionLink } from "../ui/action";
import { KindBadge } from "../ui/kind-badge";
import { FeedScrollRestoration, PostLink } from "../feed-navigation";
import styles from "./my-posts-screen.module.css";

const statusLabels: Record<PostStatus, string> = {
  published: "공개",
  pending: "확인 중",
  held: "공개 보류",
};
const statusDescriptions: Record<PostStatus, string> = {
  published: "누구나 읽을 수 있는 글이에요.",
  pending: "공개 전 확인이 끝나지 않아 나만 볼 수 있어요.",
  held: "공개가 보류되어 나만 볼 수 있어요. 자동 재확인은 제공되지 않아요.",
};

export function MyPostsScreen({ data }: { data: MyPostsScreenData }) {
  const { posts, total, counts, status, returnPath, writeHref } = data;
  const statuses: PostStatus[] = ["published", "pending", "held"];
  return (
    <div className={`shell my-posts-shell ${styles.screen}`}>
      <FeedScrollRestoration href={returnPath} />
      <div className="page-header">
        <div>
          <h1>내가 쓴 글</h1>
        </div>
        <ActionLink
          className={styles.pageWrite}
          size="compact"
          href={writeHref}
        >
          <Plus size={16} aria-hidden="true" /> 글 쓰기
        </ActionLink>
      </div>
      <p className="page-intro">
        내가 쓴 글의 공개 상태를 확인하세요. 확인 중·공개 보류 글은 나만 볼 수
        있어요.
      </p>
      <nav className={styles.filters} aria-label="내 글 공개 상태">
        <Link
          href="/me"
          className={!status ? "active" : undefined}
          aria-current={!status ? "page" : undefined}
          scroll={false}
        >
          전체 <span>{total}</span>
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
            <p>공개 보류 글은 자동으로 재확인되지 않아요.</p>
          )}
        </div>
      )}
      <div className="my-posts-list">
        {posts.length ? (
          posts.map((post) => (
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
              <span className={`${styles.status} ${styles[post.status]}`}>
                {statusLabels[post.status]}
              </span>
            </PostLink>
          ))
        ) : (
          <div className="empty-state">
            <h2>
              {total
                ? `${status ? statusLabels[status] : "선택한 상태"} 글이 없어요.`
                : "아직 남긴 글이 없어요."}
            </h2>
            <p>
              {total
                ? "다른 상태를 선택하거나 전체 글을 확인해 주세요."
                : "궁금한 점이나 분석한 내용을 글로 남겨 보세요."}
            </p>
            {total > 0 && (
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
