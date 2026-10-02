import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type {
  CommentComposerProps,
  CommentComposerState,
} from "@/lib/interaction-types";
import { createComment } from "../forum-client";
import {
  readDraft,
  saveDraft,
  commentDraftKey,
  resumeReplyKey,
} from "../drafts";
export function useCommentComposer({
  postId,
  parentId,
  viewerId,
  postPath,
  onDone,
}: CommentComposerProps): CommentComposerState {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [body, setBody] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [draftStored, setDraftStored] = useState(false);
  const draftKey = commentDraftKey(viewerId, postId, parentId);
  const storeBody = (value: string) => saveDraft(draftKey, value);
  useEffect(() => {
    try {
      const saved = readDraft(draftKey);
      if (saved) setBody(saved.slice(0, 2000));
    } catch {}
  }, [draftKey]);

  async function submit(reset: () => void) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNeedsLogin(false);
    try {
      const result = await createComment(postId, {
        body: body.trim(),
        parentId: parentId || null,
      });
      if (!result.ok) {
        if (result.status === 401) {
          setNeedsLogin(true);
          setDraftStored(storeBody(body));
        }
        setError(
          result.status === 401
            ? "댓글을 남기려면 다시 로그인해 주세요."
            : result.error || "댓글을 등록하지 못했습니다.",
        );
        return;
      }
      reset();
      setBody("");
      storeBody("");
      onDone?.();
      router.refresh();
    } catch {
      setError("연결에 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    error,
    body,
    needsLogin,
    draftStored,
    setBody(value) {
      setBody(value);
      storeBody(value);
    },
    submit,
    loginHref: `/login?returnTo=${encodeURIComponent(`${postPath}#comments`)}`,
    rememberReply() {
      saveDraft(resumeReplyKey(viewerId, postId), parentId || "root");
    },
  };
}
