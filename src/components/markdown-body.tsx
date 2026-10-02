import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownBody({ body }: { body: string }) {
  return (
    <div className="article-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          h1: ({ children }) => <h2>{children}</h2>,
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
          pre: ({ children }) => (
            <pre tabIndex={0} aria-label="코드 블록">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="markdown-table" tabIndex={0} aria-label="본문 표">
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
