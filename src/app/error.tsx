"use client";
import { useTransition } from "react";
import { ErrorScreen } from "@/components/screens/error-screen";
export default function ErrorPage({ retry }: { retry: () => void }) {
  const [pending, startTransition] = useTransition();
  return (
    <ErrorScreen
      pending={pending}
      onRetry={() => startTransition(() => retry())}
    />
  );
}
