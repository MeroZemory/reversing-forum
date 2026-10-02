"use client";
import type {
  CommentSectionProps,
  CommentComposerProps,
  ComposerSlot,
} from "@/lib/interaction-types";
import { useCommentComposer } from "@/client/hooks/use-comment-composer";
import { useCommentSection } from "@/client/hooks/use-comment-section";
import {
  CommentFormView,
  CommentSectionView,
} from "@/components/comment-section";
function CommentComposer(props: CommentComposerProps & ComposerSlot) {
  return (
    <CommentFormView
      parentId={props.parentId}
      label={props.label}
      placeholder={props.placeholder}
      state={useCommentComposer(props)}
    />
  );
}
export function CommentSection(props: CommentSectionProps) {
  const state = useCommentSection(props);
  return (
    <CommentSectionView
      comments={props.comments}
      viewer={props.viewer}
      purpose={props.purpose}
      {...state}
      renderComposer={(slot) =>
        props.viewer ? (
          <CommentComposer
            {...slot}
            postId={props.postId}
            viewerId={props.viewer.id}
            postPath={props.postPath}
          />
        ) : null
      }
    />
  );
}
