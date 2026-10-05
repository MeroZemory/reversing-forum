import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownBody } from "@/components/markdown-body";
import { highlightCodeLine, parseCodeInfo } from "@/lib/code-highlight";
import { bodyHeadings, bodySections } from "@/lib/markdown-structure";

function render(body: string, editorial = true) {
  return renderToStaticMarkup(createElement(MarkdownBody, { body, editorial }));
}

describe("technical content presentation", () => {
  it("preserves every source character while highlighting or using a plain fallback", () => {
    const samples = [
      "00401000  8B 45 FC  mov eax, [ebp-4] ; note",
      "<img onerror=alert(1)>",
      "",
      'printf("<script>"); // 설명',
    ];
    for (const language of ["disasm", "asm", "c", "python", "unknown"])
      for (const line of samples)
        expect(
          highlightCodeLine(language, line)
            .map((token) => token.text)
            .join(""),
        ).toBe(line);
    expect(
      highlightCodeLine("disasm", samples[0]).find(
        (token) => token.kind === "bytes",
      )?.text,
    ).toBe("8B 45 FC  ");
  });
  it("bounds highlight ranges to actual lines and escapes untrusted code titles", () => {
    expect(parseCodeInfo('c title="sample.c" {2-999999999999,0,1}', 5)).toEqual(
      {
        language: "c",
        title: "sample.c",
        highlights: [2, 3, 4, 5, 1],
        numbered: true,
      },
    );
    expect(
      render('```text title="<img src=x>"\n<script>alert(1)</script>\n```'),
    ).not.toContain("<img");
  });
  it("ignores headings inside fences and preserves exact section boundaries", () => {
    const body =
      "# 시작\r\n\r\n```md\r\n## 편집자 보충\r\n```\r\n\r\n## 편집자 보충\r\n설명\r\n### 상세\r\n추가\r\n## 다음\r\n끝\r\n";
    expect(bodyHeadings(body).map((h) => h.text)).toEqual([
      "시작",
      "편집자 보충",
      "다음",
    ]);
    const sections = bodySections(body);
    expect(sections.map((section) => section.body).join("")).toBe(body);
    expect(sections.find((section) => section.supplement)?.body).toContain(
      "### 상세\r\n추가",
    );
    expect(sections.find((section) => section.supplement)?.body).not.toContain(
      "## 다음",
    );
  });
  it("keeps shared reference links and footnotes across the editorial boundary", () => {
    const body =
      "설명 [공식문서][doc]와 각주[^note].\n\n## 편집자 보충\n보충 [같은문서][doc].\n\n출처: [공식문서][doc] · [다른문서](https://other.example/page)\n\n[doc]: https://docs.example/manual\n[^note]: 빠지면 안 되는 각주\n\n## 마무리\n마지막 설명";
    const html = render(body);
    expect(html.match(/href="https:\/\/docs.example\/manual"/g)).toHaveLength(
      3,
    );
    expect(html).toContain("빠지면 안 되는 각주");
    expect(html).toContain('aria-label="편집자 보충"');
    expect(html).toContain("docs.example");
    expect(html).toContain("공개 문서로 확인해 덧붙인 내용");
    expect(html).toMatch(
      /<p class="[^"]+" data-ui-decoration="true">공개 문서로 확인해 덧붙인 내용/,
    );
    expect(html).toMatch(/<\/section>\s*<h2 id="body-section-2">마무리/);
    expect(body).toContain("출처: [공식문서][doc]");
  });
  it("does not remove explanatory words from a source paragraph or claim member text was verified", () => {
    const html = render(
      "## 편집자 보충\n출처: [문서](https://docs.example/)를 읽고 비교하세요.",
      false,
    );
    expect(html).toContain("를 읽고 비교하세요.");
    expect(html).toContain("본문에 덧붙인 설명과 출처");
    expect(html).not.toContain("공개 문서로 확인");
    expect(html).not.toContain("data-source-list");
  });
  it("keeps unsafe links and raw HTML inert in supplement and code, with unique comment headings", () => {
    const html = render(
      "## 편집자 보충\n<script>alert(1)</script>\n\n출처: [위험](javascript:alert(1))\n\n```text\n<img onerror=alert(1)>\n```\n\n## 다음",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;img onerror=alert(1)&gt;");
    const comment = renderToStaticMarkup(
      createElement(MarkdownBody, {
        body: "# 설명",
        headingPrefix: "comment-42",
      }),
    );
    expect(comment).toContain('id="comment-42-1"');
  });
  it("renders plain and indented code without dropping any characters", () => {
    for (const body of [
      "```\nexact <text>\nsecond line\n```",
      "    exact <text>\n    second line",
    ]) {
      const html = render(body);
      expect(html).toContain("exact &lt;text&gt;");
      expect(html).toContain("second line");
      expect(html).toContain("복사");
      expect(html).not.toContain("language-undefined");
    }
  });
  it("gives footnotes in different comments separate link targets", () => {
    const body = "설명[^n].\n\n[^n]: 참고 내용";
    const first = renderToStaticMarkup(
      createElement(MarkdownBody, { body, headingPrefix: "comment-first" }),
    );
    const second = renderToStaticMarkup(
      createElement(MarkdownBody, { body, headingPrefix: "comment-second" }),
    );
    expect(first).toContain('id="comment-first-fn-n"');
    expect(first).toContain('href="#comment-first-fn-n"');
    expect(second).toContain('id="comment-second-fn-n"');
    expect(second).not.toContain('id="comment-first-fn-n"');
  });
});
