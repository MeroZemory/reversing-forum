"use client";
import { usePublicationRetry } from "@/client/hooks/use-publication-retry";
import { PublicationRetryView } from "@/components/publication-retry";
export function PublicationRetry({
  postId,
  independentReview = false,
}: {
  postId: string;
  independentReview?: boolean;
}) {
  const state = usePublicationRetry(postId, independentReview);
  return (
    <PublicationRetryView
      independentReview={independentReview}
      pending={state.pending}
      message={state.message}
      onRetry={state.retry}
    />
  );
}
