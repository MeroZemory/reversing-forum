import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PostForm } from "@/components/post-form";
import { getViewer } from "@/server/auth";

export const metadata: Metadata = {
  title: "글 쓰기",
  robots: { index: false, follow: false },
};

export default async function NewPost() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login?returnTo=%2Fnew");
  return (
    <div className="shell editor-shell">
      <h1>글 쓰기</h1>
      <p className="page-intro">
        질문에는 분석 환경과 확인한 내용, 막힌 지점을 함께 적어 주세요.
      </p>
      <PostForm />
    </div>
  );
}
