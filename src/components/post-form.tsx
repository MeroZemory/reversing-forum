"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Send } from "lucide-react";
import { kindLabels, postKinds } from "@/lib/types";
import { ActionLink, Button } from "./ui/action";

export function PostForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: String(form.get("title")).trim(),
          body: String(form.get("body")).trim(),
          kind: form.get("kind"),
          tags: String(form.get("tags"))
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
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
      router.push(`/posts/${result.id}`);
      router.refresh();
    } catch {
      setError(
        "연결이 끊겼습니다. 내 글에서 등록 여부를 확인한 뒤 다시 시도해 주세요.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="editor-form" onSubmit={submit}>
      <div className="editor-topline">
        <label>
          글 유형
          <select name="kind" defaultValue="discussion">
            {postKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kindLabels[kind]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="editor-label">
        제목
        <input
          name="title"
          className="title-input"
          required
          minLength={2}
          maxLength={160}
          placeholder="어떤 이야기를 나눌까요?"
        />
      </label>
      <label className="editor-label">
        본문
        <textarea
          name="body"
          required
          minLength={10}
          maxLength={30000}
          rows={15}
          placeholder="질문이나 분석 과정을 자유롭게 적어 주세요. 사용한 도구, 분석 환경과 근거를 함께 남기면 서로 이해하기 쉬워요."
        />
      </label>
      <label className="editor-label">
        태그 <span className="optional">선택</span>
        <input
          name="tags"
          maxLength={140}
          placeholder="쉼표로 구분해 주세요. 예: Windows, Ghidra, AI"
        />
        <span className="field-hint">
          태그는 최대 5개, 각 24자까지 사용할 수 있습니다.
        </span>
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="editor-footer">
        <p>
          등록한 글은 공개 전 기본 확인을 거칩니다.
          <br />
          연락처나 다른 사람의 개인정보가 포함되지 않았는지 확인해 주세요.
        </p>
        <div>
          <ActionLink variant="secondary" href="/">
            취소
          </ActionLink>
          <Button type="submit" disabled={busy}>
            {busy ? "확인하고 있습니다…" : "글 등록하기"}
            <Send size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </form>
  );
}
