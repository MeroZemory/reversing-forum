import { useRouter } from "next/navigation";
import { useState } from "react";
import { safeAuthReturn } from "@/lib/format";
import type {
  AuthFormProps,
  AuthFormState,
  AuthCommand,
} from "@/lib/interaction-types";
import { authenticate } from "../auth-service";
export function useAuthForm({ mode, returnTo }: AuthFormProps): AuthFormState {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
    try {
      const succeeded = await authenticate(mode, {
        ...command,
        name,
        email: command.email.trim(),
      });
      if (!succeeded) {
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

  return { busy, error, destination, submit };
}
