import { readFileSync } from "node:fs";
import "./auth-environment";
import { renderAuthEmail } from "./auth-email-template";
import { captureTestMail, testMailboxPath } from "./auth-test-mailbox";

function mailLinkAllowed(link: string) {
  try {
    const target = new URL(link);
    const configured = new URL(process.env.BETTER_AUTH_URL || "");
    if (
      !["http:", "https:"].includes(configured.protocol) ||
      target.origin !== configured.origin ||
      target.username ||
      target.password ||
      configured.username ||
      configured.password
    )
      return false;
    if (process.env.NODE_ENV === "production") {
      const host = target.hostname.toLowerCase();
      return (
        target.protocol === "https:" &&
        host !== "localhost" &&
        !host.endsWith(".localhost") &&
        host !== "[::1]" &&
        !host.startsWith("127.")
      );
    }
    return true;
  } catch {
    return false;
  }
}

function brandedSender() {
  const from = process.env.RESEND_FROM?.trim() || "";
  if (/[\r\n]/.test(from)) return "";
  const address = from.match(/<([^<>]+)>$/)?.[1] || from;
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address)) return "";
  return `Reversing All <${address}>`;
}

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
  return Boolean(apiKey() && brandedSender());
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
  const from = brandedSender();
  if (!key || !from || !mailLinkAllowed(url)) return false;
  try {
    const template = renderAuthEmail(url, reset);
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [email],
        ...template,
      }),
      signal: AbortSignal.timeout(10000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
