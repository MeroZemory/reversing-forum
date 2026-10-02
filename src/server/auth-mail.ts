import { readFileSync } from "node:fs";
import "./auth-environment";
import { captureTestMail, testMailboxPath } from "./auth-test-mailbox";

function apiKey() {
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY.trim();
  const file = process.env.RESEND_KEY_FILE || process.env.RESEND_API_KEY_FILE;
  if (file) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      return "";
    }
  }
  return "";
}
export function mailConfigured() {
  if (testMailboxPath()) return true;
  return Boolean(apiKey() && process.env.RESEND_FROM);
}
export function googleConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
  );
}
// Delivery failures never disclose whether an address belongs to a member.
export async function sendAuthMail(
  email: string,
  url: string,
  reset = false,
): Promise<boolean> {
  // Production ignores capture; non-production capture never falls through.
  if (testMailboxPath()) return captureTestMail(email, url, reset);
  const key = apiKey();
  if (!key || !process.env.RESEND_FROM) return false;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM,
        to: [email],
        subject: reset
          ? "Reversing All 비밀번호 재설정"
          : "Reversing All 이메일 인증",
        text: `${reset ? "비밀번호를 재설정" : "이메일을 인증"}하려면 다음 링크를 열어 주세요.\n${url}\n요청하지 않았다면 이 메일을 무시해 주세요.`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
