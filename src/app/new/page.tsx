import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PostForm } from "@/components/post-form";
import { getViewer } from "@/server/auth";
import { readFeedFilters, safeListReturn } from "@/lib/feed-navigation";

export const metadata: Metadata = {
  title: "글 쓰기",
  robots: { index: false, follow: false },
};

export default async function NewPost({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filters = readFeedFilters(params);
  const from = safeListReturn(
    typeof params.from === "string" ? params.from : undefined,
  );
  const writeParams = new URLSearchParams();
  if (filters.purpose) writeParams.set("purpose", filters.purpose);
  if (filters.tag) writeParams.set("tag", filters.tag);
  if (params.from) writeParams.set("from", from);
  const destination = `/new${writeParams.size ? `?${writeParams}` : ""}`;
  const viewer = await getViewer();
  if (!viewer) redirect(`/login?returnTo=${encodeURIComponent(destination)}`);
  return (
    <div className="shell editor-shell">
      <h1>글 쓰기</h1>
      <p className="page-intro">
        먼저 글의 목적을 고르세요. 도구·환경·AI 등 주제는 태그로 덧붙입니다.
      </p>
      <PostForm
        viewerId={viewer.id}
        initialPurpose={filters.purpose}
        initialTag={filters.tag}
        from={from}
      />
    </div>
  );
}
