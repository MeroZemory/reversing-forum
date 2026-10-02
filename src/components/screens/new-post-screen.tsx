import type { ReactNode } from "react";
export function NewPostScreen({ composer }: { composer: ReactNode }) {
  return (
    <div className="shell editor-shell">
      <h1>글 쓰기</h1>
      <p className="page-intro">
        먼저 글의 목적을 고르세요. 도구·환경·AI 등 주제는 태그로 덧붙입니다.
      </p>
      {composer}
    </div>
  );
}
