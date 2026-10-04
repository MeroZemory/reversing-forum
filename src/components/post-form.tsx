import { useEffect, useRef } from "react";
import { Send } from "lucide-react";
import type { PostFormState } from "@/lib/interaction-types";
import { ActionLink, Button } from "./ui/action";
import { MarkdownBody } from "./markdown-body";
const choices = [
  {
    kind: "question",
    label: "질문",
    hint: "답변 요청",
    guide:
      "분석 환경, 시도한 내용과 막힌 지점을 적어 주세요. 확인한 사실과 추측을 구분하면 답변에 도움이 됩니다.",
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
  from = "/",
}: {
  state: PostFormState;
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
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const choice =
    choices.find(
      (item) => item.kind === (kind === "workflow" ? "analysis" : kind),
    ) || choices[2];
  return (
    <form
      className="editor-form"
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
        <p className="field-hint">이 탭에 저장해 둔 초안을 불러왔습니다.</p>
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
      {preview ? (
        <div className="editor-preview" aria-label="본문 미리보기">
          {body.trim() ? (
            <MarkdownBody body={body} />
          ) : (
            <p className="field-hint">본문을 작성하면 여기에 표시됩니다.</p>
          )}
        </div>
      ) : (
        <label className="editor-label">
          본문
          <textarea
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
            placeholder="내용을 적어 주세요. Markdown으로 제목, 목록과 코드 블록을 작성할 수 있습니다."
          />
        </label>
      )}
      <p id="body-format-help" className="field-hint">
        코드는 ```asm 또는 ```cpp로 시작하고 ```로 닫아 주세요. HTML과 외부
        이미지는 표시하지 않습니다.
      </p>
      <label className="editor-label">
        태그 <span className="optional">선택</span>
        <input
          name="tags"
          value={tags}
          readOnly={busy}
          onChange={(event) => setTags(event.currentTarget.value)}
          maxLength={140}
          placeholder="쉼표로 구분해 주세요. 예: Windows, Ghidra, AI"
        />
        <span className="field-hint">
          도구·환경·방법을 쉼표로 구분해 주세요. 최대 5개, 각 24자까지 사용할 수
          있습니다.
        </span>
      </label>
      {error && (
        <p className="form-error" role="alert" ref={errorRef} tabIndex={-1}>
          {error}
        </p>
      )}
      <div className="editor-footer">
        <p>
          {busy ? (
            "글을 저장하고 공개 전 기본 확인을 진행하고 있습니다."
          ) : (
            <>
              {editing
                ? "수정본은 비공개로 저장하며, 기본 확인을 통과하면 공개됩니다."
                : "기본 확인을 통과한 글이 공개됩니다."}
              <br />
              {saved
                ? "작성 내용은 이 탭에 임시 저장됩니다."
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
