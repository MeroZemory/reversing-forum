import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";
import { CodeBlock } from "./code-block";
import { highlightCodeLine, parseCodeInfo } from "@/lib/code-highlight";
import { bodyHeadings } from "@/lib/markdown-structure";
import styles from "./technical-content.module.css";

type ContentNode = {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: ContentNode[];
};
function textOf(node: ContentNode): string {
  return node.value ?? node.children?.map(textOf).join("") ?? "";
}
function paragraphSources(node?: ContentNode) {
  if (!node || !textOf(node).startsWith("출처:")) return [];
  const links = node.children?.filter((child) => child.tagName === "a") ?? [];
  const other =
    node.children
      ?.filter((child) => child.tagName !== "a")
      .map(textOf)
      .join("")
      .replace(/^출처:/, "") ?? "";
  if (!links.length || !/^[\s·|,;:]*$/.test(other)) return [];
  const sources = links.flatMap((link) => {
    const href =
      typeof link.properties?.href === "string"
        ? defaultUrlTransform(link.properties.href)
        : "";
    if (!/^https?:\/\//i.test(href)) return [];
    try {
      return [{ title: textOf(link), href, domain: new URL(href).hostname }];
    } catch {
      return [];
    }
  });
  return sources.length === links.length ? sources : [];
}
export function SourceList({
  sources,
}: {
  sources: { title: string; href: string; domain: string }[];
}) {
  return (
    <div className={styles.sources}>
      <strong>출처:</strong>
      <ol>
        {sources.map((source, index) => (
          <li key={`${source.href}-${index}`}>
            <a href={source.href} rel="nofollow ugc noopener noreferrer">
              {source.title}
            </a>
            <span className={styles.sourceDomain} data-ui-decoration>
              {source.domain}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function MarkdownBody({
  body,
  headingPrefix,
  editorial = false,
}: {
  body: string;
  headingPrefix?: string;
  editorial?: boolean;
}) {
  const headings = bodyHeadings(body, headingPrefix);
  // Group the parsed nodes, not separate Markdown strings: reference links and footnotes keep their shared scope.
  const presentation = () => (tree: Root) => {
    function visit(node: Root | RootContent) {
      if (node.type === "heading") {
        const offset = node.position?.start.offset;
        const heading =
          offset === undefined
            ? undefined
            : headings.find(
                (h) => offset >= h.offset && offset <= h.offset + 3,
              );
        if (heading)
          node.data = {
            ...node.data,
            hProperties: { ...node.data?.hProperties, id: heading.id },
          };
      }
      if ("children" in node)
        for (const child of node.children) visit(child as RootContent);
    }
    visit(tree);
    const grouped: RootContent[] = [];
    for (let index = 0; index < tree.children.length; index++) {
      const node = tree.children[index];
      if (
        node.type !== "heading" ||
        ![2, 3].includes(node.depth) ||
        textOf(node).trim() !== "편집자 보충"
      ) {
        grouped.push(node);
        continue;
      }
      const children: RootContent[] = [node];
      while (index + 1 < tree.children.length) {
        const next = tree.children[index + 1];
        if (next.type === "heading" && next.depth <= node.depth) break;
        index++;
        children.push(next);
      }
      for (const child of children) {
        if (child.type === "paragraph" && textOf(child).startsWith("출처:"))
          child.data = {
            ...child.data,
            hProperties: {
              ...child.data?.hProperties,
              "data-source-list": "true",
            },
          };
      }
      const label: RootContent = {
        type: "paragraph",
        children: [
          {
            type: "text",
            value: editorial
              ? "공개 문서로 확인해 덧붙인 내용"
              : "본문에 덧붙인 설명과 출처",
          },
        ],
        data: {
          hProperties: {
            className: [styles.supplementLabel],
            "data-ui-decoration": "true",
          },
        },
      };
      grouped.push({
        type: "supplement",
        children: [label, ...children],
        data: {
          hName: "section",
          hProperties: {
            className: styles.supplement,
            "aria-label": "편집자 보충",
          },
        },
      } as unknown as RootContent);
    }
    tree.children = grouped;
  };
  return (
    <div className="article-body">
      <Markdown
        remarkPlugins={[remarkGfm, presentation]}
        remarkRehypeOptions={
          headingPrefix ? { clobberPrefix: `${headingPrefix}-` } : undefined
        }
        skipHtml
        components={{
          h1: ({ children, id }) => <h2 id={id}>{children}</h2>,
          a: ({ href, children }) => (
            <a href={href} rel="nofollow ugc noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt, src }) => (
            <a
              href={typeof src === "string" ? src : undefined}
              rel="nofollow ugc noopener noreferrer"
            >
              {alt || "첨부 이미지 링크"}
            </a>
          ),
          p: ({ node, children, className }) => {
            const sources = node?.properties?.["data-source-list"]
              ? paragraphSources(node)
              : [];
            return sources.length ? (
              <SourceList sources={sources} />
            ) : (
              <p
                className={className}
                data-ui-decoration={
                  node?.properties?.["data-ui-decoration"] ? "true" : undefined
                }
              >
                {children}
              </p>
            );
          },
          pre: ({ node }) => {
            const text = textOf(node ?? {}).replace(/\n$/, "");
            const offset = node?.position?.start.offset;
            const opening =
              offset === undefined
                ? ""
                : body.slice(offset).split(/\r?\n/, 1)[0];
            const infoText =
              opening.match(/^ {0,3}(?:`{3,}|~{3,})(.*)$/)?.[1].trim() ?? "";
            const lines = text.split("\n");
            const info = parseCodeInfo(infoText, lines.length);
            return (
              <CodeBlock
                text={text}
                lines={lines.map((line) =>
                  highlightCodeLine(info.language, line),
                )}
                {...info}
              />
            );
          },
          table: ({ children }) => (
            <div className={styles.table} tabIndex={0} aria-label="본문 표">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {body}
      </Markdown>
    </div>
  );
}
