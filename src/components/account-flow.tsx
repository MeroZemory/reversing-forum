import Link from "next/link";
import type { AccountFlowState } from "@/lib/interaction-types";
import { Button } from "./ui/action";

export function AccountFlowView({ state }: { state: AccountFlowState }) {
  const { mode, busy, error, notice, account } = state;
  const title = {
    account: "계정 관리",
    verify: "이메일 인증",
    forgot: "비밀번호 재설정 메일",
    reset: "새 비밀번호",
    onboarding: "공개 닉네임 설정",
  }[mode];
  const passwordForm =
    (mode === "reset" && Boolean(state.token)) ||
    (mode === "account" && account?.emailVerified && !account.hasPassword);
  return (
    <div className="shell auth-shell">
      <div className="auth-card">
        <h1>{title}</h1>
        {mode === "verify" && (
          <p>
            이메일 소유권을 확인한 뒤 이메일·비밀번호로 로그인할 수 있습니다.
            인증 링크는 1시간 동안 한 번 사용할 수 있습니다.
          </p>
        )}
        {mode === "forgot" && (
          <p>재설정 링크는 30분 동안 한 번 사용할 수 있습니다.</p>
        )}
        {mode === "onboarding" && (
          <p>
            글과 댓글에 표시할 닉네임을 정해 주세요. Google 이름은 공개하지
            않습니다.
          </p>
        )}
        {mode === "account" && account && (
          <>
            <p>
              {account.name} · {account.email}
            </p>
            <p>
              이메일 {account.emailVerified ? "인증 완료" : "미인증"} · 비밀번호{" "}
              {account.hasPassword ? "설정됨" : "없음"}
            </p>
            {!account.emailVerified && (
              <p>
                <Link href="/verify-email">이메일 인증하기</Link>
              </p>
            )}
            {!account.nicknameReady && (
              <p>
                <Link href="/onboarding">공개 닉네임 설정하기</Link>
              </p>
            )}
            {!account.fresh && (
              <p>
                계정 연결과 비밀번호 설정은{" "}
                <Link href="/login?returnTo=%2Faccount&reauth=1">
                  다시 로그인
                </Link>
                한 뒤 10분 안에 진행해 주세요.
              </p>
            )}
            {account.googleEnabled &&
              (account.googleAccountId ? (
                <Button
                  disabled={
                    busy ||
                    !account.fresh ||
                    !account.hasPassword ||
                    !account.emailVerified
                  }
                  onClick={() => void state.unlinkGoogle()}
                >
                  Google 연결 해제
                </Button>
              ) : (
                <Button
                  disabled={busy || !account.fresh}
                  onClick={() => void state.linkGoogle()}
                >
                  Google 연결하기
                </Button>
              ))}
            {account.googleAccountId && !account.hasPassword && (
              <p>
                연결을 해제하려면 기본 이메일로 사용할 비밀번호를 먼저 설정해
                주세요.
              </p>
            )}
            {account.hasPassword && (
              <p>
                <Link href="/forgot-password">비밀번호 재설정</Link>
              </p>
            )}
          </>
        )}
        {mode === "account" && !account && (
          <p>
            <Link href="/login?returnTo=%2Faccount">
              로그인 후 계정을 관리할 수 있습니다.
            </Link>
          </p>
        )}
        {(mode === "verify" ||
          mode === "forgot" ||
          mode === "onboarding" ||
          passwordForm) && (
          <form
            className="stack-form"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              void state.submit({
                email: String(values.get("email") || ""),
                name: String(values.get("name") || ""),
                password: String(values.get("password") || ""),
              });
            }}
          >
            {(mode === "verify" || mode === "forgot") && (
              <label>
                이메일
                <input
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  defaultValue={state.email}
                  maxLength={254}
                  readOnly={busy}
                />
              </label>
            )}
            {mode === "onboarding" && (
              <label>
                닉네임
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={30}
                  autoComplete="nickname"
                  readOnly={busy}
                />
              </label>
            )}
            {passwordForm && (
              <label>
                새 비밀번호
                <input
                  name="password"
                  type="password"
                  required
                  minLength={10}
                  maxLength={128}
                  autoComplete="new-password"
                  readOnly={busy}
                />
              </label>
            )}
            <Button
              type="submit"
              disabled={
                busy ||
                (mode === "reset" && !state.token) ||
                (mode === "account" && !account?.fresh)
              }
            >
              {busy
                ? "처리 중…"
                : passwordForm
                  ? "비밀번호 저장"
                  : mode === "onboarding"
                    ? "닉네임 저장"
                    : "메일 요청"}
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <p>
          {!account && (
            <>
              <Link href={state.loginHref || "/login"}>로그인</Link> ·{" "}
            </>
          )}
          {mode !== "account" && (
            <>
              <Link href="/account">계정 관리</Link> ·{" "}
            </>
          )}
          <Link href="/">커뮤니티로 돌아가기</Link>
        </p>
        {mode === "reset" && (
          <p>
            <Link href="/forgot-password">새 재설정 링크 요청</Link>
          </p>
        )}
      </div>
    </div>
  );
}
