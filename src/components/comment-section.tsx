"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Send, MessageSquare } from "lucide-react";
import { formatDate } from "@/lib/format";
import type { Comment, Viewer } from "@/lib/types";
import { Button } from "./ui/action";

function CommentForm({
  postId,
  parentId,
  label,
  onDone,
}: {
  postId: string;
  parentId?: string;
  label: string;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/posts/${postId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: String(form.get("body")).trim(),
          parentId: parentId || null,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(
          response.status === 401
            ? "댓글을 남기려면 다시 로그인해 주세요."
            : result.error || "댓글을 등록하지 못했습니다.",
        );
        return;
      }
      formElement.reset();
      onDone?.();
      router.refresh();
    } catch {
      setError("연결에 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="comment-form">
      <label className="sr-only">{label}</label>
      <textarea
        name="body"
        aria-label={label}
        required
        minLength={1}
        maxLength={2000}
        rows={3}
        placeholder="경험과 근거를 나누며 이야기를 이어가세요."
      />
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="comment-form-footer">
        <span>서로 존중하며 이야기를 나눠 주세요.</span>
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
}: {
  postId: string;
  comments: Comment[];
  viewer: Viewer | null;
}) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const roots = comments.filter((comment) => !comment.parentId);

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
              type="button"
              variant="quiet"
              size="compact"
              className="reply-button"
              aria-expanded={replyingTo === comment.id}
              onClick={() =>
                setReplyingTo(replyingTo === comment.id ? null : comment.id)
              }
            >
              답글
            </Button>
          )}
          {replyingTo === comment.id && !reply && (
            <CommentForm
              postId={postId}
              parentId={comment.id}
              label={`${comment.author.name}님에게 답글`}
              onDone={() => setReplyingTo(null)}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <section className="comments-section" aria-labelledby="comments-title">
      <h2 id="comments-title">
        댓글 <span>{comments.length}</span>
      </h2>
      {viewer ? (
        <CommentForm postId={postId} label="댓글 작성" />
      ) : (
        <div className="comment-login">
          <MessageSquare size={21} />
          <p>
            함께 풀어볼 생각이 있나요?
            <br />
            <Link
              href={`/login?returnTo=${encodeURIComponent(`/posts/${postId}`)}`}
            >
              로그인
            </Link>
            하면 댓글을 남길 수 있어요.
          </p>
        </div>
      )}
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
        <p className="no-comments">첫 댓글로 이야기를 이어가 주세요.</p>
      )}
    </section>
  );
}
