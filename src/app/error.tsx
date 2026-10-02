"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="shell not-found">
      <h1>페이지를 불러오지 못했습니다.</h1>
      <p>잠시 후 다시 시도해 주세요.</p>
      <button className="button" onClick={reset}>
        다시 시도하기
      </button>
    </div>
  );
}
