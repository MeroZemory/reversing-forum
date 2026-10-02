"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { getPostPurpose, type PostKind, type PostPurpose } from "@/lib/types";
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

export function PostForm({
  viewerId,
  initialPurpose,
  initialTag,
  from = "/",
}: {
  viewerId: string;
  initialPurpose?: PostPurpose;
  initialTag?: string;
  from?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState(initialTag || "");
  const [kind, setKind] = useState<PostKind>(
    choices.find((choice) => getPostPurpose(choice.kind) === initialPurpose)
      ?.kind || "discussion",
  );
  const [preview, setPreview] = useState(false);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(false);
  const [restored, setRestored] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const submitted = useRef(false);
  const mounted = useRef(true);
  const draftKey = `reversing-all:draft:${viewerId}`;
  const choice = choices.find((item) => item.kind === kind) || choices[2];
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(draftKey);
      if (stored) {
        const draft = JSON.parse(stored);
        if (
          typeof draft.title === "string" &&
          typeof draft.body === "string" &&
          typeof draft.tags === "string" &&
          choices.some((item) => item.kind === draft.kind)
        ) {
          setTitle(draft.title.slice(0, 160));
          setBody(draft.body.slice(0, 30000));
          setTags(draft.tags.slice(0, 140));
          setKind(draft.kind);
          setRestored(true);
        }
      }
    } catch {}
    setReady(true);
  }, [draftKey]);

  useEffect(() => {
    if (!ready || submitted.current) return;
    try {
      if (title || body || tags) {
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({ title, body, tags, kind }),
        );
        setSaved(true);
      } else {
        sessionStorage.removeItem(draftKey);
        setSaved(false);
      }
    } catch {
      setSaved(false);
    }
  }, [title, body, tags, kind, ready, draftKey]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const parsedTags = [
      ...new Set(
        tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
    if (title.trim().length < 2 || body.trim().length < 10) {
      setPreview(false);
      setError("제목은 2자 이상, 본문은 10자 이상 입력해 주세요.");
      return;
    }
    if (parsedTags.length > 5 || parsedTags.some((tag) => tag.length > 24)) {
      setError("태그는 최대 5개, 각 24자까지 입력할 수 있습니다.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          kind,
          tags: parsedTags,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(
          response.status === 401
            ? "글을 쓰려면 다시 로그인해 주세요."
            : result.error ||
                "글을 등록하지 못했습니다. 입력한 내용을 확인해 주세요.",
        );
        return;
      }
      submitted.current = true;
      try {
        sessionStorage.removeItem(draftKey);
      } catch {}
      if (mounted.current) {
        router.push(`/posts/${result.id}?from=${encodeURIComponent(from)}`);
        router.refresh();
      }
    } catch {
      setError(
        "연결이 끊겼습니다. 내 글에서 등록 여부를 확인한 뒤 다시 시도해 주세요.",
      );
    } finally {
      if (!submitted.current) setBusy(false);
    }
  }

  return (
    <form className="editor-form" onSubmit={submit} aria-busy={busy}>
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
                checked={kind === item.kind}
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
              기본 확인을 통과한 글이 공개됩니다.
              <br />
              {saved
                ? "작성 내용은 이 탭에 임시 저장됩니다."
                : "등록 전에 공개할 내용을 확인해 주세요."}
            </>
          )}
        </p>
        <div>
          <ActionLink variant="secondary" href={from}>
            목록으로
          </ActionLink>
          <Button type="submit" disabled={busy}>
            {busy ? "기본 확인 중…" : "글 등록하기"}
            <Send size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </form>
  );
}
