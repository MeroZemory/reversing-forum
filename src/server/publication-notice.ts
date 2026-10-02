import "server-only";
import { db } from "./db";
import { getPublicationNotice } from "./publication-control";

export type PublicationNotice = {
  reason:
    | "duplicate"
    | "waiting"
    | "screening"
    | "size"
    | "budget"
    | "busy"
    | "attempt-limit";
  relatedPosts: { id: string; title: string }[];
  canRetry: boolean;
  canRequestReview: boolean;
};

// Owner-facing projection only. Never send screening evidence, private candidate
// names, model prompts, embeddings, or another author's unpublished existence.
export function publicationNotice(
  id: string,
  viewerId?: string,
): PublicationNotice | null {
  if (!viewerId) return null;
  const post = db
    .prepare(
      "SELECT status FROM posts WHERE id=? AND author_id=? AND status<>'published'",
    )
    .get(id, viewerId);
  if (!post) return null;
  const notice = getPublicationNotice(id, viewerId);
  if (!notice) return null;
  const reason =
    notice.reasonCode === "duplicate"
      ? "duplicate"
      : notice.reasonCode === "attempt_limit"
        ? "attempt-limit"
        : notice.reasonCode === "publication_busy" ||
            notice.reasonCode === "global_call_limit"
          ? "busy"
          : notice.reasonCode === "input_too_large"
            ? "size"
            : notice.reasonCode === "budget_exhausted"
              ? "budget"
              : notice.reasonCode === "minimum_held"
                ? "screening"
                : "waiting";
  const relatedPosts = notice.relatedPublishedIds
    .slice(0, 8)
    .flatMap((candidateId: string) => {
      const item = db
        .prepare("SELECT id,title FROM posts WHERE id=? AND status='published'")
        .get(candidateId) as { id: string; title: string } | undefined;
      return item ? [item] : [];
    });
  return {
    reason,
    relatedPosts,
    canRetry: notice.canRetry,
    canRequestReview: notice.canRequestReview,
  };
}
