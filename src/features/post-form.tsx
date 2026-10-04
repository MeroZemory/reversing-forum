"use client";
import type { PostFormProps } from "@/lib/interaction-types";
import { usePostComposer } from "@/client/hooks/use-post-composer";
import { PostFormView } from "@/components/post-form";
export function PostForm(props: PostFormProps) {
  const cancelHref = props.editing
    ? `/posts/${props.editing.id}?from=${encodeURIComponent(props.from || "/")}`
    : props.from;
  return <PostFormView state={usePostComposer(props)} from={cancelHref} />;
}
