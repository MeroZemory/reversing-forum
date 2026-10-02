"use client";

import { ActionLink, Button } from "@/components/ui/action";
import { useTransition } from "react";

export default function ErrorPage({ retry }: { retry: () => void }) {
  const [pending, startTransition] = useTransition();
  function tryAgain() {
    startTransition(() => retry());
  }
  return (
    <div className="shell not-found">
      <h1>페이지를 불러오지 못했습니다.</h1>
      <p>다시 불러오거나 글 목록으로 이동해 주세요.</p>
      <div className="recovery-actions">
        <Button type="button" onClick={tryAgain} disabled={pending}>
          {pending ? "다시 불러오는 중…" : "다시 시도하기"}
        </Button>
        <ActionLink href="/" variant="secondary">
          글 목록으로
        </ActionLink>
      </div>
    </div>
  );
}
