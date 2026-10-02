"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "./ui/action";

export function AccountButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function signOut() {
    setBusy(true);
    setError(false);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("sign out failed");
      router.push("/");
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="account-control" aria-busy={busy}>
      <Button
        type="button"
        variant="quiet"
        size="compact"
        className="text-button"
        onClick={signOut}
        disabled={busy}
      >
        {busy ? "로그아웃 중…" : "로그아웃"}
      </Button>
      {error && (
        <span role="alert" className="inline-error">
          로그아웃하지 못했습니다. 다시 시도해 주세요.
        </span>
      )}
    </span>
  );
}
