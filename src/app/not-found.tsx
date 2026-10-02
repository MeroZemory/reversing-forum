import { ActionLink } from "@/components/ui/action";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "페이지를 찾을 수 없습니다",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <div className="shell not-found">
      <span className="eyebrow muted">404</span>
      <h1>페이지를 찾을 수 없습니다.</h1>
      <p>주소를 확인해 주세요. 공개되지 않은 글은 작성자만 볼 수 있습니다.</p>
      <div className="recovery-actions">
        <ActionLink href="/">글 목록으로</ActionLink>
        <ActionLink href="/me" variant="secondary">
          내가 쓴 글 확인
        </ActionLink>
      </div>
    </div>
  );
}
