"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Send, MessageSquare } from "lucide-react";
import { formatDate } from "@/lib/format";
import type { Comment, Viewer, PostPurpose } from "@/lib/types";
import { ActionLink, Button } from "./ui/action";

function CommentForm({
  postId,
  parentId,
  label,
  onDone,
  placeholder,
  viewerId,
  postPath,
}: {
  postId: string;
  parentId?: string;
  label: string;
  onDone?: () => void;
  placeholder: string;
  viewerId: string;
  postPath: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [body, setBody] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [draftStored, setDraftStored] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const inputId = `comment-${parentId || "new"}`;
  const draftKey = `reversing-all:comment:${viewerId}:${postId}:${parentId || "root"}`;
  function saveDraft(value: string) {
    try {
      if (value) sessionStorage.setItem(draftKey, value);
      else sessionStorage.removeItem(draftKey);
      return true;
    } catch {
      return false;
    }
  }
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(draftKey);
      if (saved) setBody(saved.slice(0, 2000));
    } catch {}
  }, [draftKey]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const formElement = event.currentTarget;
    setBusy(true);
    setError("");
    setNeedsLogin(false);
    try {
      const response = await fetch(`/api/posts/${postId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: body.trim(),
          parentId: parentId || null,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401) {
          setNeedsLogin(true);
          setDraftStored(saveDraft(body));
        }
        setError(
          response.status === 401
            ? "댓글을 남기려면 다시 로그인해 주세요."
            : result.error || "댓글을 등록하지 못했습니다.",
        );
        return;
      }
      formElement.reset();
      setBody("");
      saveDraft("");
      onDone?.();
      router.refresh();
    } catch {
      setError("연결에 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="comment-form" aria-busy={busy}>
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
          saveDraft(event.currentTarget.value);
        }}
      />
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
            href={`/login?returnTo=${encodeURIComponent(`${postPath}#comments`)}`}
            onNavigate={() => {
              try {
                sessionStorage.setItem(
                  `reversing-all:resume-reply:${viewerId}:${postId}`,
                  parentId || "root",
                );
              } catch {}
            }}
          >
            다시 로그인
          </ActionLink>
        </div>
      )}
      <div className="comment-form-footer">
        <span>{body.length.toLocaleString("ko-KR")} / 2,000자</span>
        <Button type="submit" size="compact" disabled={busy}>
          {busy ? "등록 중…" : parentId ? "답글 등록" : "댓글 등록"}
          <Send size={14} aria-hidden="true" />
        </Button>
      </div>
    </form>
  );
}

export function CommentSection({
  postId,
  comments,
  viewer,
  postPath,
  purpose,
}: {
  postId: string;
  comments: Comment[];
  viewer: Viewer | null;
  postPath: string;
  purpose: PostPurpose;
}) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const roots = comments.filter((comment) => !comment.parentId);
  useEffect(() => {
    if (!viewer) return;
    try {
      const key = `reversing-all:resume-reply:${viewer.id}:${postId}`;
      const parent = sessionStorage.getItem(key);
      if (!parent) return;
      sessionStorage.removeItem(key);
      if (
        comments.some((comment) => comment.id === parent && !comment.parentId)
      )
        setReplyingTo(parent);
    } catch {}
  }, [postId, viewer?.id, comments, viewer]);

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
          <p className="comment-body">{comment.body}</p>
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
          {replyingTo === comment.id && !reply && (
            <CommentForm
              postId={postId}
              parentId={comment.id}
              label={`${comment.author.name}님에게 답글`}
              placeholder={`${comment.author.name}님의 댓글에 답글을 남겨 주세요.`}
              onDone={() => closeReply(comment.id)}
              viewerId={viewer!.id}
              postPath={postPath}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <section
      id="comments"
      className="comments-section"
      aria-labelledby="comments-title"
    >
      <h2 id="comments-title">
        댓글 <span>{comments.length}</span>
      </h2>
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
        <p className="no-comments">아직 댓글이 없습니다.</p>
      )}
      <div className="comment-composer">
        {viewer ? (
          <CommentForm
            postId={postId}
            label="댓글 작성"
            placeholder={placeholder}
            viewerId={viewer.id}
            postPath={postPath}
          />
        ) : (
          <div className="comment-login">
            <MessageSquare size={18} aria-hidden="true" />
            <p>댓글로 질문에 답하거나 의견을 나눠 주세요.</p>
            <ActionLink
              variant="secondary"
              size="compact"
              href={`/login?returnTo=${encodeURIComponent(`${postPath}#comments`)}`}
            >
              로그인하고 댓글 쓰기
            </ActionLink>
          </div>
        )}
      </div>
    </section>
  );
}
