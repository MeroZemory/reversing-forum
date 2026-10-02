import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AccountButtonState } from "@/lib/interaction-types";
import { signOut as performSignOut } from "../auth-service";
export function useSignOut(): AccountButtonState {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function signOut() {
    setBusy(true);
    setError(false);
    try {
      const result = await performSignOut();
      if (!result) throw new Error("sign out failed");
      router.push("/");
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, signOut };
}
