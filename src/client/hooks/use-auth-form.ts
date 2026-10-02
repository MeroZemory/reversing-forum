import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { safeAuthReturn } from "@/lib/format";
import type {
  AuthFormProps,
  AuthFormState,
  AuthCommand,
} from "@/lib/interaction-types";
import {
  authenticate,
  getPublicAuthConfig,
  googleSignIn,
} from "../auth-service";
export function useAuthForm({ mode, returnTo }: AuthFormProps): AuthFormState {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<"email" | "google">();
  const [error, setError] = useState("");
  const [googleEnabled, setGoogleEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    if (new URLSearchParams(window.location.search).has("error"))
      setError(
        "Google 인증을 완료하지 못했습니다. 계정 선택과 연결 권한을 확인한 뒤 다시 시도해 주세요.",
      );
    void getPublicAuthConfig()
      .then((config) => {
        if (active) setGoogleEnabled(config.googleEnabled);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const registering = mode === "register";
  const destination = safeAuthReturn(returnTo);
  async function submit(command: AuthCommand, onValidationError?: () => void) {
    if (busy) return;
    setError("");
    const name = (command.name || "").trim();
    if (registering && (name.length < 2 || name.length > 30)) {
      setError("닉네임은 앞뒤 공백을 제외하고 2~30자로 입력해 주세요.");
      onValidationError?.();
      return;
    }
    setBusy(true);
    setPending("email");
    try {
      const succeeded = await authenticate(
        mode,
        {
          ...command,
          name,
          email: command.email.trim(),
        },
        destination,
      );
      if (!succeeded) {
        setError(
          registering
            ? "가입하지 못했습니다. 입력한 정보와 이메일을 확인해 주세요."
            : "로그인하지 못했습니다. 이메일 인증을 완료했는지, 이메일과 비밀번호가 맞는지 확인해 주세요.",
        );
        return;
      }
      router.push(
        registering
          ? `/verify-email?returnTo=${encodeURIComponent(destination)}`
          : destination,
      );
      router.refresh();
    } catch {
      setError(
        `${registering ? "회원가입" : "로그인"}하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.`,
      );
    } finally {
      setBusy(false);
      setPending(undefined);
    }
  }

  async function google() {
    if (busy) return;
    setBusy(true);
    setPending("google");
    setError("");
    try {
      await googleSignIn(
        destination,
        false,
        registering ? "/register" : "/login",
      );
    } catch {
      setError(
        "Google 인증을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      );
      setBusy(false);
      setPending(undefined);
    }
  }
  return { busy, pending, error, destination, submit, googleEnabled, google };
}
