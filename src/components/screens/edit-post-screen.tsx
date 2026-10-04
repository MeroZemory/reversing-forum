import type { ReactNode } from "react";

export function EditPostScreen({ composer }: { composer: ReactNode }) {
  return (
    <div className="shell editor-shell">
      <h1>글 수정</h1>
      <p className="page-intro">
        저장한 수정본은 기본 확인을 통과하면 공개됩니다. 확인 중에는 작성자만
        글을 볼 수 있습니다.
      </p>
      {composer}
    </div>
  );
}
