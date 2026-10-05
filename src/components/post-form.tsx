import { useEffect, useRef } from "react";
import Link from "next/link";
import { Send } from "lucide-react";
import type { PostFormState } from "@/lib/interaction-types";
import { ActionLink, Button } from "./ui/action";
import { MarkdownBody } from "./markdown-body";
import { canonicalTopic, topicAliases } from "@/lib/topic-aliases";
import styles from "./post-form.module.css";
const choices = [
  {
    kind: "question",
    label: "질문",
    hint: "답변 요청",
    guide:
      "분석 환경, 시도한 내용과 막힌 지점을 적어 주세요. 확인한 사실과 추측을 구분하면 답변에 도움이 돼요.",
  },
  {
    kind: "analysis",
    label: "공유",
    hint: "분석·방법",
    guide:
      "재현 환경과 분석 과정, 확인한 근거를 함께 남겨 주세요. AI를 활용했다면 제안받은 내용과 직접 검증한 결과를 구분해 주세요.",
  },
  {
    kind: "discussion",
    label: "자유",
    hint: "소식·생각",
    guide: "리버싱에 관한 소식, 경험이나 생각을 자유롭게 나눠 주세요.",
  },
] as const;

export function PostFormView({
  state,
  similarPosts = [],
  from = "/",
}: {
  state: PostFormState;
  similarPosts?: { id: string; title: string; tags?: string[] }[];
  from?: string;
}) {
  const {
    editing,
    busy,
    error,
    title,
    body,
    tags,
    kind,
    preview,
    saved,
    restored,
    setTitle,
    setBody,
    setTags,
    setKind,
    setPreview,
    submit,
  } = state;
  const errorRef = useRef<HTMLParagraphElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const selectionRef = useRef({ start: 0, end: 0 });
  const visibleSimilar = similarPosts;
  const suggestedTopics = [
    ...new Set([
      ...Object.keys(topicAliases),
      ...visibleSimilar.flatMap((post) => post.tags ?? []).map(canonicalTopic),
    ]),
  ];
  const lastTag = tags.split(",").at(-1)?.trim() ?? "";
  const suggestions = lastTag
    ? suggestedTopics
        .filter(
          (tag) =>
            tag
              .toLocaleLowerCase()
              .includes(canonicalTopic(lastTag).toLocaleLowerCase()) &&
            tag !== lastTag,
        )
        .slice(0, 5)
    : [];
  function insertMarkdown(type: "code" | "disasm" | "table" | "link") {
    if (busy || preview) return;
    const start = bodyRef.current?.selectionStart ?? selectionRef.current.start;
    const end = bodyRef.current?.selectionEnd ?? selectionRef.current.end;
    const selected = body.slice(start, end);
    const content =
      selected ||
      (type === "link"
        ? "링크 이름"
        : type === "table"
          ? "내용"
          : "여기에 코드를 적어 주세요");
    const opening =
      type === "code"
        ? "```cpp\n"
        : type === "disasm"
          ? "```disasm\n"
          : type === "table"
            ? "| 항목 | 설명 |\n| --- | --- |\n| "
            : "[";
    const closing =
      type === "link"
        ? "](https://example.com)"
        : type === "table"
          ? " | 설명 |\n"
          : "\n```";
    const prefix =
      type !== "link" && start > 0 && body[start - 1] !== "\n" ? "\n" : "";
    const suffix =
      type !== "link" && end < body.length && body[end] !== "\n" ? "\n" : "";
    const next =
      body.slice(0, start) +
      prefix +
      opening +
      content +
      closing +
      suffix +
      body.slice(end);
    if (next.length > 30000) return;
    setBody(next);
    requestAnimationFrame(() => {
      const input = bodyRef.current;
      if (!input) return;
      input.focus();
      const position = start + prefix.length + opening.length;
      input.setSelectionRange(position, position + content.length);
    });
  }
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const choice =
    choices.find(
      (item) => item.kind === (kind === "workflow" ? "analysis" : kind),
    ) || choices[2];
  return (
    <form
      className={`editor-form ${styles.form}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      aria-busy={busy}
    >
      <fieldset className="purpose-picker" disabled={busy}>
        <legend>작성 목적</legend>
        <div className="purpose-options">
          {choices.map((item) => (
            <label className="purpose-option" key={item.kind}>
              <input
                type="radio"
                name="kind"
                value={item.kind}
                aria-label={item.label}
                checked={
                  kind === item.kind ||
                  (kind === "workflow" && item.kind === "analysis")
                }
                onChange={() => setKind(item.kind)}
              />
              <span>
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="editor-context">{choice.guide}</p>
      {restored && (
        <p className="field-hint">이 탭에 저장해 둔 초안을 불러왔어요.</p>
      )}
      <label className="editor-label">
        제목
        <input
          name="title"
          className="title-input"
          value={title}
          readOnly={busy}
          onChange={(event) => setTitle(event.currentTarget.value)}
          required
          minLength={2}
          maxLength={160}
          placeholder={
            kind === "question"
              ? "어디에서 막혔는지 한 문장으로 적어 주세요"
              : kind === "analysis"
                ? "분석하거나 공유할 내용을 한 문장으로 적어 주세요"
                : "어떤 이야기를 나눌까요?"
          }
        />
      </label>
      {!!visibleSimilar.length && (
        <aside className={styles.similar} aria-label="비슷한 공개 글">
          <p>비슷한 글이 있어요 · 먼저 확인해 보세요</p>
          {visibleSimilar.map((post) => (
            <Link
              key={post.id}
              href={`/posts/${encodeURIComponent(post.id)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {post.title}
              <span className={styles.external}> (새 탭)</span>
            </Link>
          ))}
        </aside>
      )}
      <div className={styles.bodyHeading}>
        <label htmlFor="post-body">본문</label>
        <div className="editor-tabs" aria-label="본문 보기 방식">
          <button
            type="button"
            aria-pressed={!preview}
            disabled={busy}
            onClick={() => setPreview(false)}
          >
            작성
          </button>
          <button
            type="button"
            aria-pressed={preview}
            disabled={busy}
            onClick={() => setPreview(true)}
          >
            미리보기
          </button>
        </div>
      </div>
      {!preview && (
        <div className={styles.tools} role="group" aria-label="Markdown 넣기">
          {(
            [
              ["code", "코드"],
              ["disasm", "디스어셈블리"],
              ["table", "표"],
              ["link", "링크"],
            ] as const
          ).map(([type, label]) => (
            <button
              key={type}
              type="button"
              disabled={busy}
              onClick={() => insertMarkdown(type)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {preview ? (
        <div className="editor-preview" aria-label="본문 미리보기">
          {body.trim() ? (
            <MarkdownBody body={body} />
          ) : (
            <p className="field-hint">본문을 작성하면 여기에 표시돼요.</p>
          )}
        </div>
      ) : (
        <label className="editor-label">
          <textarea
            id="post-body"
            ref={bodyRef}
            onSelect={(event) => {
              selectionRef.current = {
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
              };
            }}
            name="body"
            readOnly={busy}
            aria-label="본문"
            aria-describedby="body-format-help"
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
            required
            minLength={10}
            maxLength={30000}
            rows={10}
            placeholder="내용을 적어 주세요. Markdown으로 제목, 목록과 코드 블록을 작성할 수 있어요."
          />
        </label>
      )}
      <p id="body-format-help" className="field-hint">
        코드·디스어셈블리는 버튼으로 넣거나 ```로 감싸요. HTML과 외부 이미지는
        표시하지 않아요.
      </p>
      <label className="editor-label">
        주제 <span className="optional">선택</span>
        <input
          name="tags"
          aria-label="태그"
          value={tags}
          readOnly={busy}
          onChange={(event) => setTags(event.currentTarget.value)}
          maxLength={140}
          placeholder="쉼표로 구분해 주세요. 예: Windows, Ghidra, AI"
        />
        <span className="field-hint">
          도구·환경·방법을 쉼표로 구분해 주세요. 최대 5개, 각 24자까지 사용할 수
          있어요.
        </span>
      </label>
      {!!suggestions.length && (
        <div className={styles.suggestions} role="group" aria-label="주제 제안">
          {suggestions.map((tag) => (
            <button
              type="button"
              disabled={busy}
              key={tag}
              onClick={() => {
                const parts = tags.split(",");
                parts[parts.length - 1] = tag;
                const next = parts.join(",");
                if (next.length <= 140) setTags(next);
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {tags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag && canonicalTopic(tag) !== tag)
        .map((tag, index) => (
          <p className="field-hint" key={`${tag}-${index}`}>
            ‘{tag}’는 {canonicalTopic(tag)} 주제로 함께 보여요. 입력한 원래
            표기는 그대로 저장해요.
          </p>
        ))}
      {error && (
        <p className="form-error" role="alert" ref={errorRef} tabIndex={-1}>
          {error}
        </p>
      )}
      <div className="editor-footer">
        <p>
          {busy ? (
            "글을 저장하고 공개 전 기본 확인을 진행하고 있어요."
          ) : (
            <>
              {editing
                ? "수정본은 비공개로 저장하며, 기본 확인을 통과하면 공개돼요."
                : "기본 확인을 통과한 글이 공개돼요."}
              <br />
              {saved
                ? "작성 내용은 이 탭에 임시 저장돼요."
                : editing
                  ? "저장 전에 수정할 내용을 확인해 주세요."
                  : "등록 전에 공개할 내용을 확인해 주세요."}
            </>
          )}
        </p>
        <div>
          <ActionLink variant="secondary" href={from}>
            {editing ? "취소" : "목록으로"}
          </ActionLink>
          <Button type="submit" disabled={busy}>
            {busy ? "기본 확인 중…" : editing ? "수정 저장하기" : "글 등록하기"}
            <Send size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </form>
  );
}
