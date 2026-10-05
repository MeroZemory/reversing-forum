"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { CodeToken } from "@/lib/code-highlight";
import styles from "./technical-content.module.css";

const languageLabels: Record<string, string> = {
  c: "C",
  cpp: "C++",
  asm: "어셈블리",
  disasm: "디스어셈블리",
  python: "Python",
  shell: "명령",
  text: "텍스트",
  json: "JSON",
};

export function CodeBlock({
  text,
  lines,
  language,
  title,
  highlights,
  numbered,
}: {
  text: string;
  lines: CodeToken[][];
  language: string;
  title: string;
  highlights: number[];
  numbered: boolean;
}) {
  const [wrap, setWrap] = useState(false);
  const [bytes, setBytes] = useState<boolean | null>(null);
  const [wide, setWide] = useState(false);
  const [copyState, setCopyState] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const media = matchMedia("(min-width: 600px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("복사했어요");
    } catch {
      setCopyState("복사하지 못했어요. 코드를 직접 선택해 주세요.");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState(""), 2500);
  }
  const label = languageLabels[language] ?? language;
  return (
    <figure
      className={styles.code}
      data-bytes={bytes === null ? "auto" : bytes ? "show" : "hide"}
    >
      <figcaption className={styles.codeBar}>
        <span>{label}</span>
        {title && <span className={styles.codeTitle}>{title}</span>}
        <div className={styles.codeTools}>
          {language === "disasm" && (
            <button
              type="button"
              aria-pressed={bytes ?? wide}
              onClick={() => setBytes(!(bytes ?? wide))}
            >
              바이트
            </button>
          )}
          <button
            type="button"
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            줄바꿈
          </button>
          <button type="button" onClick={copy}>
            복사
          </button>
        </div>
      </figcaption>
      <pre
        tabIndex={0}
        aria-label={`코드 블록 · ${label}${title ? ` · ${title}` : ""}`}
        className={wrap ? styles.wrap : undefined}
      >
        <code>
          {lines.map((tokens, index) => (
            <Fragment key={index}>
              <span
                className={styles.codeLine}
                data-highlight={highlights.includes(index + 1) || undefined}
              >
                {numbered && (
                  <span className={styles.lineNumber} aria-hidden="true">
                    {index + 1}
                  </span>
                )}
                {tokens.map((token, n) => (
                  <span data-token={token.kind} key={n}>
                    {token.text}
                  </span>
                ))}
              </span>
              {index < lines.length - 1 ? "\n" : ""}
            </Fragment>
          ))}
        </code>
      </pre>
      <span role="status" className={styles.copyStatus}>
        {copyState}
      </span>
    </figure>
  );
}
