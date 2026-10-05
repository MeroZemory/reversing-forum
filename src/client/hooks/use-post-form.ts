import { useEffect, useState } from "react";
import type { PostFormProps } from "@/lib/interaction-types";
import { postDraftKey, readDraft } from "../drafts";
import { usePostComposer } from "./use-post-composer";

const formErrors: Record<string, string> = {
  "태그는 최대 5개, 각 24자까지 입력할 수 있습니다.":
    "태그는 최대 5개, 각 24자까지 입력할 수 있어요.",
  "수정 내용을 저장하지 못했습니다. 입력한 내용을 확인해 주세요.":
    "수정 내용을 저장하지 못했어요. 입력한 내용을 확인해 주세요.",
  "글을 등록하지 못했습니다. 입력한 내용을 확인해 주세요.":
    "글을 등록하지 못했어요. 입력한 내용을 확인해 주세요.",
  "연결이 끊겼습니다. 내 글에서 저장 여부를 확인한 뒤 다시 시도해 주세요.":
    "연결이 끊겼어요. 내 글에서 저장 여부를 확인한 뒤 다시 시도해 주세요.",
};

// Keep the existing composer responsible for sessions, drafts and submission.
export function usePostForm(props: PostFormProps) {
  const state = usePostComposer(props);
  useEffect(() => {
    if (props.editing || !props.initialTitle) return;
    try {
      const stored = readDraft(postDraftKey(props.viewerId));
      if (stored) {
        const draft = JSON.parse(stored);
        if (
          typeof draft.title === "string" &&
          typeof draft.body === "string" &&
          typeof draft.tags === "string" &&
          ["question", "analysis", "discussion", "workflow"].includes(
            draft.kind,
          )
        )
          return;
      }
    } catch {}
    state.setTitle(props.initialTitle.slice(0, 160));
  }, [props.viewerId, props.editing, props.initialTitle]);
  const { title } = state;
  const [similar, setSimilar] = useState<
    { id: string; title: string; tags?: string[] }[]
  >([]);
  const [similarTitle, setSimilarTitle] = useState("");
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const words =
      title
        .trim()
        .replace(
          /([가-힣]{2,})(에서|으로|은|는|이|가|을|를|의|에)(?=\s|$)/g,
          "$1",
        )
        .match(/[\p{L}\p{N}_+#.-]+/gu) ?? [];
    const query = (
      words.find(
        (word) =>
          word.length >= 2 &&
          !["어떻게", "무엇", "왜", "있나요", "하나요"].includes(word),
      ) ?? ""
    ).slice(0, 200);
    setSimilar([]);
    if (query.length < 2) return;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/posts?${new URLSearchParams({ query, limit: "3" })}`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const posts: unknown = await response.json();
        if (active && Array.isArray(posts)) {
          setSimilar(
            posts
              .filter(
                (post) =>
                  typeof post?.id === "string" &&
                  typeof post?.title === "string",
              )
              .slice(0, 3),
          );
          setSimilarTitle(title);
        }
      } catch {}
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [title]);
  const visibleSimilar = similarTitle === title ? similar : [];
  return {
    ...state,
    error: formErrors[state.error] ?? state.error,
    similarPosts: visibleSimilar,
  };
}
