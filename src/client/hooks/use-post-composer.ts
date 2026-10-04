import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getPostPurpose, type PostKind } from "@/lib/types";
import type { PostFormProps, PostFormState } from "@/lib/interaction-types";
import { createPost, editPost } from "../forum-client";
import {
  readDraft,
  saveDraft,
  postDraftKey,
  postEditDraftKey,
} from "../drafts";
const choices = [
  { kind: "question" },
  { kind: "analysis" },
  { kind: "discussion" },
] as const;
export function usePostComposer({
  viewerId,
  initialPurpose,
  initialTag,
  from = "/",
  editing,
}: PostFormProps): PostFormState {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState(editing?.title || "");
  const [body, setBody] = useState(editing?.body || "");
  const [tags, setTags] = useState(
    editing?.tags.join(", ") || initialTag || "",
  );
  const [kind, setKind] = useState<PostKind>(
    editing?.kind ||
      choices.find((choice) => getPostPurpose(choice.kind) === initialPurpose)
        ?.kind ||
      "discussion",
  );
  const [preview, setPreview] = useState(false);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(false);
  const [restored, setRestored] = useState(false);
  const submitted = useRef(false);
  const mounted = useRef(true);
  const draftKey = editing
    ? postEditDraftKey(viewerId, editing.id, editing.expectedHash)
    : postDraftKey(viewerId);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setTitle(editing?.title || "");
    setBody(editing?.body || "");
    setTags(editing?.tags.join(", ") || initialTag || "");
    setKind(
      editing?.kind ||
        choices.find((choice) => getPostPurpose(choice.kind) === initialPurpose)
          ?.kind ||
        "discussion",
    );
    setRestored(false);
    try {
      const stored = readDraft(draftKey);
      if (stored) {
        const draft = JSON.parse(stored);
        if (
          typeof draft.title === "string" &&
          typeof draft.body === "string" &&
          typeof draft.tags === "string" &&
          (choices.some((item) => item.kind === draft.kind) ||
            draft.kind === "workflow")
        ) {
          setTitle(draft.title.slice(0, 160));
          setBody(draft.body.slice(0, 30000));
          setTags(draft.tags.slice(0, 140));
          setKind(draft.kind);
          setRestored(true);
        }
      }
    } catch {}
    setReady(true);
  }, [draftKey]);

  useEffect(() => {
    if (!ready || submitted.current) return;
    try {
      if (title || body || tags) {
        const stored = saveDraft(
          draftKey,
          JSON.stringify({ title, body, tags, kind }),
        );
        setSaved(stored);
      } else {
        saveDraft(draftKey, "");
        setSaved(false);
      }
    } catch {
      setSaved(false);
    }
  }, [title, body, tags, kind, ready, draftKey]);

  async function submit() {
    if (busy) return;
    const parsedTags = [
      ...new Set(
        tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
    if (title.trim().length < 2 || body.trim().length < 10) {
      setPreview(false);
      setError("제목은 2자 이상, 본문은 10자 이상 입력해 주세요.");
      return;
    }
    if (parsedTags.length > 5 || parsedTags.some((tag) => tag.length > 24)) {
      setError("태그는 최대 5개, 각 24자까지 입력할 수 있습니다.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const command = {
        title: title.trim(),
        body: body.trim(),
        kind,
        tags: parsedTags,
      };
      const result = editing
        ? await editPost(editing.id, {
            ...command,
            expectedHash: editing.expectedHash,
          })
        : await createPost(command);
      if (!result.ok) {
        setError(
          result.status === 401
            ? "글을 쓰려면 다시 로그인해 주세요."
            : result.error ||
                (editing
                  ? "수정 내용을 저장하지 못했습니다. 입력한 내용을 확인해 주세요."
                  : "글을 등록하지 못했습니다. 입력한 내용을 확인해 주세요."),
        );
        return;
      }
      submitted.current = true;
      try {
        saveDraft(draftKey, "");
      } catch {}
      if (mounted.current) {
        router.push(
          `/posts/${result.data.id}?from=${encodeURIComponent(from)}`,
        );
        router.refresh();
      }
    } catch {
      setError(
        "연결이 끊겼습니다. 내 글에서 저장 여부를 확인한 뒤 다시 시도해 주세요.",
      );
    } finally {
      if (!submitted.current) setBusy(false);
    }
  }

  return {
    editing: !!editing,
    busy,
    error,
    title,
    body,
    tags,
    kind,
    preview,
    saved,
    restored,
    setTitle,
    setBody,
    setTags,
    setKind,
    setPreview,
    submit,
  };
}
