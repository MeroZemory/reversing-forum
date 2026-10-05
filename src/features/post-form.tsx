"use client";
import type { PostFormProps } from "@/lib/interaction-types";
import { usePostForm } from "@/client/hooks/use-post-form";
import { PostFormView } from "@/components/post-form";
export function PostForm(props: PostFormProps) {
  const state = usePostForm(props);
  const cancelHref = props.editing
    ? `/posts/${props.editing.id}?from=${encodeURIComponent(props.from || "/")}`
    : props.from;
  return (
    <PostFormView
      state={state}
      similarPosts={state.similarPosts}
      from={cancelHref}
    />
  );
}
