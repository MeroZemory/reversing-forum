"use client";
import { useState } from "react";
import { sendReport } from "@/client/report-service";
import type { ReportReason } from "@/contracts/reports";
import { ReportFormView } from "@/components/report-form";
export function ReportForm({ postId }: { postId?: string }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [sent, setSent] = useState(false);
  async function submit(reason: ReportReason, detail: string) {
    if (busy || sent) return;
    setBusy(true);
    setError("");
    try {
      await sendReport({ postId, reason, detail });
      setSent(true);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "접수하지 못했습니다. 다시 시도해 주세요.",
      );
    } finally {
      setBusy(false);
    }
  }
  return <ReportFormView state={{ busy, error, sent, submit }} />;
}
