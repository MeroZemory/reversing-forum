import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { getViewer } from "@/server/auth";
import { listMyPosts } from "@/server/forum";
import { formatDate } from "@/lib/format";
import { ActionLink } from "@/components/ui/action";
import { KindBadge } from "@/components/ui/kind-badge";

export const metadata: Metadata = {
  title: "내 글",
  robots: { index: false, follow: false },
};

export default async function MyPosts() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login?returnTo=%2Fme");
  const posts = listMyPosts(viewer.id);
  return (
    <div className="shell my-posts-shell">
      <div className="feed-heading">
        <div>
          <h1>내가 쓴 글</h1>
        </div>
        <ActionLink size="compact" href="/new">
          <Plus size={16} aria-hidden="true" /> 글 쓰기
        </ActionLink>
      </div>
      <p className="page-intro">
        공개 전 확인 중인 글도 여기에서 볼 수 있습니다.
      </p>
      <div className="my-posts-list">
        {posts.length ? (
          posts.map((post) => (
            <Link
              className="my-post-row"
              key={post.id}
              href={`/posts/${post.id}`}
            >
              <div>
                <KindBadge kind={post.kind} />
                <h2>{post.title}</h2>
                <time dateTime={post.createdAt}>
                  {formatDate(post.createdAt)}
                </time>
              </div>
              <span
                className={`status-badge ${post.status === "published" ? "status-published" : ""}`}
              >
                {post.status === "published" ? "공개됨" : "확인 중"}
              </span>
            </Link>
          ))
        ) : (
          <div className="empty-state">
            <h2>아직 남긴 글이 없습니다.</h2>
            <p>첫 질문이나 오늘의 발견을 공유해 보세요.</p>
          </div>
        )}
      </div>
    </div>
  );
}
