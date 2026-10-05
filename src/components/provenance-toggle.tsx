"use client";
import { useId, useState } from "react";
import Link from "next/link";
import type { EditorialProvenance } from "@/lib/types";
import { formatDate } from "@/lib/format";
import styles from "./post-reading.module.css";

export function ProvenanceToggle({
  provenance,
  createdAt,
  postId,
  sourceCount,
  hasSupplement,
}: {
  provenance: EditorialProvenance;
  createdAt: string;
  postId: string;
  sourceCount?: number;
  hasSupplement?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const chat = provenance.sourceType === "chat-editorial";
  return (
    <div className={styles.provenance}>
      <button
        type="button"
        className={styles.provenanceButton}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        출처와 확인 <span aria-hidden="true">{open ? "⌃" : "⌄"}</span>
      </button>
      <aside
        id={id}
        hidden={!open}
        className={styles.provenancePanel}
        aria-label="자료 출처와 확인 상태"
      >
        <dl>
          <div>
            <dt>자료</dt>
            <dd>{chat ? "과거 카톡 편집 자료" : "별도로 작성한 안내 자료"}</dd>
          </div>
          <div>
            <dt>{chat ? "과거 기록 기간" : "자료 기준 기간"}</dt>
            <dd>{provenance.period || "기간 미확인"}</dd>
          </div>
          <div>
            <dt>웹 게시</dt>
            <dd>
              <time dateTime={createdAt}>{formatDate(createdAt)}</time>
            </dd>
          </div>
          <div>
            <dt>확인 내역</dt>
            <dd>
              {provenance.verificationSummary.trim() ||
                "확인 상태가 기록되지 않았어요."}
            </dd>
          </div>
          <div>
            <dt>편집자 보충</dt>
            <dd>
              {sourceCount
                ? `출처 ${sourceCount}개를 표시했어요.`
                : hasSupplement
                  ? "추가 설명이 있어요. 공개 문서 출처는 표시되지 않았어요."
                  : "추가 설명과 공개 문서 출처가 없어요."}
            </dd>
          </div>
        </dl>
        <p>
          기록 시점과 웹 게시일은 달라요. 현재 내용·효력은 별도 확인이 필요해요.
        </p>
        <p>당시 도구·환경 기준이라 지금은 다를 수 있어요.</p>
        <p>
          <Link href="/guide">편집 자료 안내</Link> ·{" "}
          <Link href={`/report?post=${encodeURIComponent(postId)}`}>
            정정·삭제 요청
          </Link>
        </p>
      </aside>
    </div>
  );
}
