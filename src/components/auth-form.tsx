import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { AuthFormState, AuthMode } from "@/lib/interaction-types";
import { Button } from "./ui/action";
import { GoogleAuthIcon } from "./google-auth-icon";
export function AuthFormView({
  mode,
  state,
}: {
  mode: AuthMode;
  state: AuthFormState;
}) {
  const { busy, error, destination, submit } = state;
  const registering = mode === "register";
  const [showPassword, setShowPassword] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const pathname = new URL(destination, "http://localhost").pathname;
  const continuation =
    pathname === "/new"
      ? "글 작성을 이어갈 수 있습니다."
      : pathname.startsWith("/posts/")
        ? "읽던 글로 돌아가 댓글을 남길 수 있습니다."
        : pathname === "/me"
          ? "내가 쓴 글과 공개 상태를 확인할 수 있습니다."
          : "글과 댓글을 작성할 수 있습니다.";

  return (
    <div className="auth-card" aria-busy={busy}>
      <h1>{registering ? "회원가입" : "로그인"}</h1>
      <p>
        {registering ? "가입하면 " : "로그인하면 "}
        {continuation}
      </p>
      {registering && <p>이메일 가입은 인증 메일을 확인해야 완료됩니다.</p>}
      {error && (
        <p
          id="auth-error"
          className="form-error"
          role="alert"
          tabIndex={-1}
          ref={errorRef}
        >
          {error}
        </p>
      )}
      {state.googleEnabled && (
        <div style={{ marginTop: "var(--space-6)" }}>
          <Button
            type="button"
            variant="secondary"
            fullWidth
            disabled={busy}
            style={{
              backgroundColor: "#fff",
              borderColor: "#747775",
              color: "#1f1f1f",
              fontSize: 14,
              fontWeight: 500,
              gap: 10,
              paddingInline: 12,
            }}
            onClick={() => void state.google?.()}
            aria-describedby={
              error ? "google-auth-hint auth-error" : "google-auth-hint"
            }
          >
            <GoogleAuthIcon />
            {state.pending === "google"
              ? "Google로 이동 중…"
              : "Google로 계속하기"}
          </Button>
          <p
            id="google-auth-hint"
            className="field-hint"
            style={{ textAlign: "center", marginTop: "var(--space-2)" }}
          >
            첫 가입 후 공개 닉네임을 정합니다.
          </p>
          <p
            className="field-hint"
            style={{ textAlign: "center", marginTop: "var(--space-5)" }}
          >
            {registering ? "또는 이메일로 가입" : "또는 이메일로 로그인"}
          </p>
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void submit(
            {
              name: String(form.get("name") ?? ""),
              email: String(form.get("email")),
              password: String(form.get("password")),
            },
            () => errorRef.current?.focus(),
          );
        }}
        className="stack-form"
        aria-busy={busy}
        aria-describedby={error ? "auth-error" : undefined}
      >
        {registering && (
          <label>
            닉네임
            <input
              name="name"
              readOnly={busy}
              required
              minLength={2}
              maxLength={30}
              autoComplete="nickname"
              placeholder="커뮤니티에서 사용할 이름"
            />
          </label>
        )}
        <label>
          이메일
          <input
            name="email"
            readOnly={busy}
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            placeholder="you@example.com"
          />
        </label>
        <div className="field">
          <label htmlFor="auth-password">비밀번호</label>
          <div className="password-field">
            <input
              id="auth-password"
              name="password"
              readOnly={busy}
              type={showPassword ? "text" : "password"}
              required
              minLength={registering ? 10 : undefined}
              maxLength={128}
              aria-describedby={registering ? "password-hint" : undefined}
              autoComplete={registering ? "new-password" : "current-password"}
              placeholder={
                registering
                  ? "10자 이상 입력해 주세요"
                  : "비밀번호를 입력해 주세요"
              }
            />
            <Button
              type="button"
              variant="quiet"
              className="password-toggle"
              aria-label={
                showPassword ? "비밀번호 숨기기" : "비밀번호 표시하기"
              }
              aria-controls="auth-password"
              aria-pressed={showPassword}
              onClick={() => setShowPassword((visible) => !visible)}
            >
              {showPassword ? "숨기기" : "보기"}
            </Button>
          </div>
          {registering && (
            <p id="password-hint" className="field-hint">
              비밀번호는 10~128자로 입력해 주세요.
            </p>
          )}
        </div>
        <Button type="submit" fullWidth disabled={busy}>
          {state.pending === "email"
            ? registering
              ? "가입 요청 중…"
              : "로그인 중…"
            : registering
              ? "이메일로 가입"
              : "이메일로 로그인"}
        </Button>
      </form>
      {!registering && (
        <p>
          <Link href="/forgot-password">비밀번호 재설정</Link> ·{" "}
          <Link
            href={`/verify-email?returnTo=${encodeURIComponent(destination)}`}
          >
            인증 메일 다시 받기
          </Link>
        </p>
      )}
      <p className="auth-switch">
        {registering ? "이미 계정이 있나요?" : "계정이 없나요?"}{" "}
        <Link
          href={`${registering ? "/login" : "/register"}?returnTo=${encodeURIComponent(destination)}`}
        >
          {registering ? "로그인" : "회원가입"}
        </Link>
      </p>
    </div>
  );
}
