import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUTH_RESET_TTL_SECONDS,
  AUTH_VERIFICATION_TTL_SECONDS,
  renderAuthEmail,
} from "@/server/auth-email-template";

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("authentication email template", () => {
  it.each([
    [false, "이메일 인증", "이메일 인증하기", 60],
    [true, "비밀번호 재설정", "비밀번호 재설정하기", 30],
  ] as const)(
    "renders the purpose and expiry (reset=%s)",
    (reset, title, action, minutes) => {
      const url = "https://forum.example.test/auth?token=synthetic&next=%2F";
      const mail = renderAuthEmail(url, reset);
      expect(mail.subject).toBe(`[Reversing All] ${title}`);
      expect(mail.html).toContain(`<h1 `);
      expect(mail.html).toContain(`>${title}</h1>`);
      expect(mail.html.match(/<a\b/g)).toHaveLength(2);
      expect(mail.html).toContain(`>${action}</a>`);
      expect(mail.text).toContain(action);
      expect(mail.html).toContain(`발송 후 ${minutes}분 동안 유효합니다.`);
      expect(mail.text).toContain(`발송 후 ${minutes}분 동안 유효합니다.`);
      expect(mail.text).toContain(
        "직접 요청하지 않으셨다면 이 메일을 무시해 주세요.",
      );
      expect(mail.html).toContain('<html lang="ko">');
      expect(mail.html).not.toMatch(
        /<(?:img|script|link|iframe|style)\b|@import|url\(/i,
      );
      expect(mail.html).toContain("max-width:600px");
      expect(mail.html).toContain("table-layout:fixed");
      expect(mail.html).not.toContain(`>${url}</`);
    },
  );

  it("defaults to verification and exports the existing TTLs in seconds", () => {
    expect(renderAuthEmail("https://forum.example.test/verify")).toEqual(
      renderAuthEmail("https://forum.example.test/verify", false),
    );
    expect(AUTH_VERIFICATION_TTL_SECONDS).toBe(3600);
    expect(AUTH_RESET_TTL_SECONDS).toBe(1800);
  });

  it("escapes malicious attribute and text content without altering the actual URL", () => {
    const url = `https://forum.example.test/verify?token=" onmouseover="evil()&next=<script>alert('x')</script>`;
    const { html, text } = renderAuthEmail(url);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)];
    expect(hrefs).toHaveLength(2);
    for (const href of hrefs) expect(decodeHtml(href[1])).toBe(url);
    expect(html).toContain(
      "&quot; onmouseover=&quot;evil()&amp;next=&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;",
    );
    expect(html).not.toMatch(/<script|" onmouseover="/);
    expect(text.split("\n\n")).toContain(url);
  });

  it.each([false, true])(
    "preserves long URLs and all visible copy in plaintext (reset=%s)",
    (reset) => {
      const url = `https://forum.example.test/auth?token=${"synthetic".repeat(300)}&callbackURL=${encodeURIComponent("https://forum.example.test/account?tab=security&from=mail")}`;
      const { html, text } = renderAuthEmail(url, reset);
      const visibleHtml = decodeHtml(
        html.replace(/<head>[\s\S]*?<\/head>/, "").replace(/<[^>]*>/g, " "),
      )
        .replace(/\s+/g, " ")
        .trim();
      for (const paragraph of text
        .split("\n\n")
        .filter((part) => part !== url)) {
        expect(visibleHtml).toContain(paragraph);
      }
      expect(visibleHtml).not.toContain(url);
      expect(decodeHtml(html.match(/href="([^"]*)"/)![1])).toBe(url);
      expect(text.split("\n\n").filter((part) => part === url)).toHaveLength(1);
    },
  );

  it("keeps the rendered email aligned with the current site token subset", () => {
    const css = readFileSync(
      new URL("../../src/app/tokens.css", import.meta.url),
      "utf8",
    );
    const tokens = Object.fromEntries(
      [...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [
        match[1],
        match[2].replace(/\s+/g, " ").trim(),
      ]),
    );
    const html = decodeHtml(
      renderAuthEmail("https://forum.example.test/verify").html,
    );
    const styles: Record<string, string> = {
      "color-canvas": "background-color",
      "color-panel": "background-color",
      "color-ink": "color",
      "color-muted": "color",
      "color-header": "background-color",
      "color-header-text": "color",
      "color-primary": "background-color",
      "color-on-primary": "color",
      "font-prose": "font-family",
      "weight-bold": "font-weight",
      "leading-prose": "line-height",
      "leading-tight": "line-height",
      "radius-md": "border-radius",
    };
    for (const [token, property] of Object.entries(styles)) {
      expect(tokens[token], token).toBeTruthy();
      expect(html, token).toContain(`${property}:${tokens[token]};`);
    }
    expect(html).toContain(`border:1px solid ${tokens["color-border"]};`);
    expect(html).toContain(
      `border-bottom:4px solid ${tokens["color-brand-accent"]};`,
    );
    expect(html).toContain(
      `padding:${tokens["space-8"]} ${tokens["space-7"]};`,
    );
    expect(html).toContain(`margin:0 0 ${tokens["space-5"]};`);
    for (const token of ["text-sm", "text-base", "text-title"]) {
      expect(tokens[token], token).toMatch(/^[\d.]+rem$/);
      expect(html, token).toContain(
        `font-size:${parseFloat(tokens[token]) * 16}px;`,
      );
    }
  });
});
