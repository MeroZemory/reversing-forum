"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { safeReturnPath } from "@/lib/format";
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
  const registering = mode === "register";
  const destination = safeReturnPath(returnTo);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    setBusy(true);
    try {
      const credentials = {
        email: String(form.get("email")).trim(),
        password: String(form.get("password")),
      };
      const result = registering
        ? await authClient.signUp.email({
            ...credentials,
            name: String(form.get("name")).trim(),
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
      setError("연결에 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <h1>{registering ? "회원가입" : "로그인"}</h1>
      <p>
        {registering
          ? "가입하면 글과 댓글을 작성할 수 있습니다."
          : "이메일과 비밀번호를 입력해 주세요."}
      </p>
      <form onSubmit={submit} className="stack-form">
        {registering && (
          <label>
            닉네임
            <input
              name="name"
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
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            placeholder="you@example.com"
          />
        </label>
        <label>
          비밀번호
          <input
            name="password"
            type="password"
            required
            minLength={10}
            maxLength={128}
            autoComplete={registering ? "new-password" : "current-password"}
            placeholder={
              registering
                ? "10자 이상 입력해 주세요"
                : "비밀번호를 입력해 주세요"
            }
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
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
