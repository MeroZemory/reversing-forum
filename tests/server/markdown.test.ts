import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownBody } from "@/components/markdown-body";

describe("research content rendering", () => {
  it("renders headings, code and a GFM table without adding a second page title", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        body: "# 분석 과정\n\n```asm\ncmp eax, 42\n```\n\n|주소|명령|\n|---|---|\n|0x10|ret|",
      }),
    );
    expect(html).toContain('<h2 id="body-section-1">분석 과정</h2>');
    expect(html).not.toContain("<h1>");
    expect(html).toContain("코드 블록 · 어셈블리");
    expect(html).toContain('data-token="register">eax</span>');
    expect(html).toContain('data-token="number">42</span>');
    expect(html).toContain("<table>");
  });
  it("keeps untrusted HTML and script links out of executable markup and avoids remote image loads", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        body: "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert(1))\n\n![자료](https://other.example/tracking.png)\n\n```html\n<img onerror=alert(1)>\n```",
      }),
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;img onerror=alert(1)&gt;");
    expect(html).toContain('rel="nofollow ugc noopener noreferrer"');
  });
});
