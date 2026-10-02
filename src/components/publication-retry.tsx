"use client";
export function PublicationRetryView({
  pending,
  message,
  onRetry,
  independentReview = false,
}: {
  pending: boolean;
  message: string;
  onRetry: () => void;
  independentReview?: boolean;
}) {
  return (
    <div>
      <button
        type="button"
        className="button button-secondary"
        disabled={pending}
        onClick={onRetry}
      >
        {pending
          ? "확인 중…"
          : independentReview
            ? "중복 판정 재확인"
            : "다시 확인"}
      </button>
      {independentReview && (
        <p className="field-hint">
          다른 모델이 현재 글 전체를 다시 비교합니다. 글마다 한 번 요청할 수
          있습니다.
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
