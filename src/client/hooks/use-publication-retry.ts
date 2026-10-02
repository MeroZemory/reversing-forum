"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { retryPost, reviewPost } from "../forum-client";

export function usePublicationRetry(postId: string, independentReview = false) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  async function retry() {
    if (pending) return;
    setPending(true);
    setMessage("");
    try {
      const result = await (independentReview
        ? reviewPost(postId)
        : retryPost(postId));
      if (!result.ok)
        setMessage(
          result.error || "다시 확인하지 못했습니다. 잠시 후 시도해 주세요.",
        );
      else {
        setMessage(
          result.data.status === "published"
            ? "글이 공개됐습니다."
            : result.data.status === "held"
              ? "확인 결과 공개가 보류됐습니다."
              : "아직 확인이 끝나지 않았습니다. 글은 비공개로 유지됩니다.",
        );
        router.refresh();
      }
    } catch {
      setMessage("다시 확인하지 못했습니다. 잠시 후 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }
  return { pending, message, retry };
}
