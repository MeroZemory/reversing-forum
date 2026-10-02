import { useEffect, useState } from "react";
import type { CommentSectionProps } from "@/lib/interaction-types";
import { readDraft, saveDraft, resumeReplyKey } from "../drafts";
export function useCommentSection({
  postId,
  viewer,
  comments,
  postPath,
}: CommentSectionProps) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  useEffect(() => {
    if (!viewer) return;
    try {
      const key = resumeReplyKey(viewer.id, postId);
      const parent = readDraft(key);
      if (!parent) return;
      if (!saveDraft(key, "")) return;
      if (
        comments.some((comment) => comment.id === parent && !comment.parentId)
      )
        setReplyingTo(parent);
    } catch {}
  }, [postId, viewer?.id, comments, viewer]);

  return {
    replyingTo,
    setReplyingTo,
    loginHref: `/login?returnTo=${encodeURIComponent(`${postPath}#comments`)}`,
  };
}
