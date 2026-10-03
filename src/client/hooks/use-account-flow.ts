import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { safeAuthReturn } from "@/lib/format";
import type {
  AccountData,
  AccountFlowMode,
  AccountFlowState,
} from "@/lib/interaction-types";
import {
  googleSignIn,
  loadAccount,
  requestReset,
  requestVerification,
  resetPassword,
  setPassword,
  unlinkGoogle,
  updateNickname,
} from "../auth-service";

export function useAccountFlow(props: {
  mode: AccountFlowMode;
  token?: string;
  error?: string;
  verified?: boolean;
  returnTo?: string;
}): AccountFlowState {
  const router = useRouter();
  const [account, setAccount] = useState<AccountData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    props.error
      ? props.mode === "reset"
        ? "재설정 링크가 만료되었거나 이미 사용되었습니다. 새 재설정 메일을 요청해 주세요."
        : props.mode === "verify"
          ? "인증 링크가 만료되었거나 이미 사용되었습니다. 인증 메일을 다시 요청해 주세요."
          : "Google 연결을 완료하지 못했습니다. 다시 로그인한 뒤 연결을 시도해 주세요."
      : props.mode === "reset" && !props.token
        ? "메일에서 비밀번호 재설정 링크를 열어 주세요."
        : "",
  );
  const [notice, setNotice] = useState(
    props.verified && !props.error
      ? "이메일 인증을 완료했습니다. 이제 로그인해 주세요."
      : "",
  );
  useEffect(() => {
    let active = true;
    void loadAccount()
      .then((data) => {
        if (active) setAccount(data);
      })
      .catch(() => {
        if (active)
          setError("계정 정보를 불러오지 못했습니다. 새로고침해 주세요.");
      });
    return () => {
      active = false;
    };
  }, []);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "처리하지 못했습니다. 다시 시도해 주세요.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function submit(values: {
    email?: string;
    name?: string;
    password?: string;
  }) {
    await run(async () => {
      if (props.mode === "forgot" || props.mode === "verify") {
        const email = (values.email || account?.email || "").trim();
        if (props.mode === "forgot") await requestReset(email);
        else await requestVerification(email, props.returnTo);
        setNotice(
          props.mode === "verify"
            ? "가입한 미인증 이메일에만 인증 메일을 요청합니다. Google로 가입했거나 이미 인증했다면 다시 받을 필요 없이 로그인할 수 있습니다. 메일이 오지 않으면 입력한 주소와 스팸함을 확인해 주세요."
            : "입력한 주소가 대상 계정이라면 메일을 보냅니다. 받은편지함과 스팸함을 확인해 주세요. 도착하지 않으면 잠시 후 다시 요청해 주세요.",
        );
      } else if (props.mode === "reset") {
        if (!props.token)
          throw new Error(
            "재설정 링크가 필요합니다. 메일을 다시 요청해 주세요.",
          );
        await resetPassword(props.token, values.password || "");
        setNotice("비밀번호를 변경했습니다. 새 비밀번호로 로그인해 주세요.");
      } else if (props.mode === "onboarding") {
        await updateNickname((values.name || "").trim());
        router.push(safeAuthReturn(props.returnTo));
        router.refresh();
      } else {
        await setPassword(values.password || "");
        setAccount(await loadAccount());
        setNotice("이제 기본 이메일과 비밀번호로 로그인할 수 있습니다.");
      }
    });
  }
  return {
    mode: props.mode,
    verificationStatus:
      props.mode !== "verify" || props.error
        ? "required"
        : props.verified
          ? "complete"
          : account?.emailVerified
            ? "already-verified"
            : "required",
    account,
    busy,
    error,
    notice,
    email: account?.email || "",
    token: props.token,
    submit,
    loginHref: `/login?returnTo=${encodeURIComponent(safeAuthReturn(props.returnTo))}`,
    continueHref: safeAuthReturn(props.returnTo),
    linkGoogle: () => run(() => googleSignIn("/account", true)),
    unlinkGoogle: () =>
      run(async () => {
        if (!account?.googleAccountId) return;
        await unlinkGoogle(account.googleAccountId);
        setAccount(await loadAccount());
        setNotice("Google 연결을 해제했습니다.");
      }),
  };
}
