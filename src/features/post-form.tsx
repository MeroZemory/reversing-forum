"use client";
import type { PostFormProps } from "@/lib/interaction-types";
import { usePostComposer } from "@/client/hooks/use-post-composer";
import { PostFormView } from "@/components/post-form";
export function PostForm(props: PostFormProps) {
  return <PostFormView state={usePostComposer(props)} from={props.from} />;
}
