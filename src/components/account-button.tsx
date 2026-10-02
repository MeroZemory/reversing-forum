import type { AccountButtonState } from "@/lib/interaction-types";
import { Button } from "./ui/action";
export function AccountButtonView({ state }: { state: AccountButtonState }) {
  const { busy, error, signOut } = state;
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
