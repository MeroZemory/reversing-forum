import type { PostStatus } from "@/lib/types";

export const statusLabels: Record<PostStatus, string> = {
  published: "공개",
  pending: "공개 전 확인",
  held: "공개 보류",
};

export const statusDescriptions: Record<PostStatus, string> = {
  published: "누구나 읽을 수 있는 글이에요.",
  pending: "공개 전 확인이 끝나지 않아 작성자만 볼 수 있어요.",
  held: "공개가 보류되어 작성자만 볼 수 있어요. 자동 재확인은 제공하지 않아요.",
};

export function StatusBadge({ status }: { status: PostStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      {statusLabels[status]}
    </span>
  );
}
