import { useEffect, useRef } from "react";
import { Send, MessageSquare } from "lucide-react";
import { formatDate } from "@/lib/format";
import type { Comment } from "@/lib/types";
import type {
  CommentFormViewProps,
  CommentSectionViewProps,
} from "@/lib/interaction-types";
import { ActionLink, Button } from "./ui/action";
import { MarkdownBody } from "./markdown-body";
export function CommentFormView({
  parentId,
  label,
  placeholder,
  state,
}: CommentFormViewProps) {
  const {
    busy,
    error,
    body,
    needsLogin,
    draftStored,
    setBody,
    submit,
    loginHref,
    rememberReply,
  } = state;
  const errorRef = useRef<HTMLParagraphElement>(null);
  const inputId = `comment-${parentId || "new"}`;
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        void submit(() => form.reset());
      }}
      className="comment-form"
      aria-busy={busy}
    >
      <label className="sr-only" htmlFor={inputId}>
        {label}
      </label>
      <textarea
        id={inputId}
        name="body"
        value={body}
        readOnly={busy}
        aria-label={label}
        required
        minLength={1}
        maxLength={2000}
        rows={3}
        placeholder={placeholder}
        autoFocus={!!parentId}
        onChange={(event) => {
          setBody(event.currentTarget.value);
        }}
        aria-describedby={`${inputId}-hint`}
      />
      <p id={`${inputId}-hint`} className="field-hint">
        코드는 ```로 감싸면 읽기 쉬워요. 마크다운을 쓸 수 있어요.
      </p>
      {error && (
        <p role="alert" className="form-error" ref={errorRef} tabIndex={-1}>
          {error}
        </p>
      )}
      {needsLogin && (
        <div className="comment-auth-recovery">
          <p className="field-hint">
            {draftStored
              ? "작성한 내용은 이 탭에 남아 있습니다."
              : "다시 로그인하기 전에 작성한 내용을 복사해 두세요."}
          </p>
          <ActionLink
            variant="secondary"
            size="compact"
            href={loginHref}
            onNavigate={rememberReply}
          >
            다시 로그인
          </ActionLink>
        </div>
      )}
      <div className="comment-form-footer">
        <span>{body.length.toLocaleString("ko-KR")} / 2,000자</span>
        <Button type="submit" size="compact" disabled={busy}>
          {busy
            ? "등록 중…"
            : parentId
              ? "답글 등록"
              : label === "답변 작성"
                ? "답변 등록"
                : "댓글 등록"}
          <Send size={14} aria-hidden="true" />
        </Button>
      </div>
    </form>
  );
}

export function CommentSectionView({
  comments,
  viewer,
  purpose,
  replyingTo,
  setReplyingTo,
  loginHref,
  renderComposer,
}: CommentSectionViewProps) {
  const roots = comments.filter((comment) => !comment.parentId);
  const question = purpose === "question";
  function closeReply(id: string) {
    setReplyingTo(null);
    requestAnimationFrame(() =>
      document.getElementById(`reply-${id}`)?.focus(),
    );
  }
  const placeholder =
    purpose === "question"
      ? "확인한 원인이나 다음에 시도할 방법을 알려 주세요."
      : purpose === "share"
        ? "재현한 결과나 보완할 내용을 나눠 주세요."
        : "이 글에 대한 생각을 남겨 주세요.";

  function renderComment(comment: Comment, reply = false) {
    return (
      <div
        className={`comment ${reply ? "comment-reply" : ""}`}
        key={comment.id}
      >
        <span className="avatar" aria-hidden="true">
          {comment.author.name.slice(0, 1)}
        </span>
        <div className="comment-content">
          <div className="comment-heading">
            <strong>{comment.author.name}</strong>
            <time dateTime={comment.createdAt}>
              {formatDate(comment.createdAt)}
            </time>
          </div>
          <div className="comment-body">
            <MarkdownBody
              body={comment.body}
              headingPrefix={`comment-${comment.id}`}
            />
          </div>
          {viewer && !reply && (
            <Button
              id={`reply-${comment.id}`}
              type="button"
              variant="quiet"
              size="compact"
              className="reply-button"
              aria-expanded={replyingTo === comment.id}
              onClick={() =>
                setReplyingTo(replyingTo === comment.id ? null : comment.id)
              }
            >
              {replyingTo === comment.id ? "답글 닫기" : "답글"}
            </Button>
          )}
          {replyingTo === comment.id &&
            !reply &&
            renderComposer({
              parentId: comment.id,
              label: `${comment.author.name}님에게 답글`,
              placeholder: `${comment.author.name}님의 댓글에 답글을 남겨 주세요.`,
              onDone: () => closeReply(comment.id),
            })}
        </div>
      </div>
    );
  }

  return (
    <section
      id={question ? "answers" : "comments"}
      className="comments-section"
      aria-labelledby="comments-title"
    >
      <h2 id="comments-title">
        {question ? "답변" : "댓글"} <span>{comments.length}</span>
      </h2>
      {question && <span id="comments" aria-hidden="true" />}
      <div className="comments-list">
        {roots.map((root) => (
          <div className="comment-thread" key={root.id}>
            {renderComment(root)}
            {comments
              .filter((comment) => comment.parentId === root.id)
              .map((reply) => renderComment(reply, true))}
          </div>
        ))}
      </div>
      {comments.length === 0 && (
        <p className="no-comments">
          {question
            ? "아직 답변이 없어요. 확인한 원인이나 시도할 방법을 알려 주세요."
            : "아직 댓글이 없어요."}
        </p>
      )}
      <div className="comment-composer">
        {viewer ? (
          renderComposer({
            label: question ? "답변 작성" : "댓글 작성",
            placeholder,
          })
        ) : (
          <div className="comment-login">
            <MessageSquare size={18} aria-hidden="true" />
            <p>
              {question
                ? "한 줄 답도 도움이 돼요."
                : "재현한 결과나 의견을 나눠 주세요."}
            </p>
            <ActionLink variant="secondary" size="compact" href={loginHref}>
              {question ? "로그인하고 답변 쓰기" : "로그인하고 댓글 쓰기"}
            </ActionLink>
          </div>
        )}
      </div>
    </section>
  );
}
