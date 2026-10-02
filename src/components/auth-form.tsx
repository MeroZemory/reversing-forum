"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { safeAuthReturn } from "@/lib/format";
import { Button } from "./ui/action";

export function AuthForm({
  mode,
  returnTo,
}: {
  mode: "login" | "register";
  returnTo?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const registering = mode === "register";
  const destination = safeAuthReturn(returnTo);
  const pathname = new URL(destination, "http://localhost").pathname;
  const continuation =
    pathname === "/new"
      ? "글 작성을 이어갈 수 있습니다."
      : pathname.startsWith("/posts/")
        ? "읽던 글로 돌아가 댓글을 남길 수 있습니다."
        : pathname === "/me"
          ? "내가 쓴 글과 공개 상태를 확인할 수 있습니다."
          : "글과 댓글을 작성할 수 있습니다.";

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setError("");
    const name = String(form.get("name") ?? "").trim();
    if (registering && (name.length < 2 || name.length > 30)) {
      setError("닉네임은 앞뒤 공백을 제외하고 2~30자로 입력해 주세요.");
      errorRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const credentials = {
        email: String(form.get("email")).trim(),
        password: String(form.get("password")),
      };
      const result = registering
        ? await authClient.signUp.email({
            ...credentials,
            name,
          })
        : await authClient.signIn.email(credentials);
      if (result.error) {
        setError(
          registering
            ? "가입하지 못했습니다. 입력한 정보와 이메일을 확인해 주세요."
            : "로그인하지 못했습니다. 이메일과 비밀번호를 확인해 주세요.",
        );
        return;
      }
      router.push(destination);
      router.refresh();
    } catch {
      setError(
        `${registering ? "회원가입" : "로그인"}하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <h1>{registering ? "회원가입" : "로그인"}</h1>
      <p>
        {registering ? "가입하면 " : "로그인하면 "}
        {continuation}
      </p>
      <form
        onSubmit={submit}
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
        <Button type="submit" fullWidth disabled={busy}>
          {busy ? "잠시만 기다려 주세요…" : registering ? "회원가입" : "로그인"}
          <ArrowRight size={16} />
        </Button>
      </form>
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
