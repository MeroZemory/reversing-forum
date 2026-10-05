"use client";

import Link from "next/link";
import { useState } from "react";
import { topicVariants } from "@/lib/topic-aliases";
import { listHref } from "@/lib/resource-navigation";
import styles from "./topic-filter.module.css";

export function TopicFilter({
  topics,
}: {
  topics: { tag: string; count: number }[];
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const matches = [...topics]
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .filter(({ tag }) =>
      topicVariants(tag).some((value) =>
        value.toLocaleLowerCase().includes(needle),
      ),
    );
  const frequent = matches.filter(({ count }) => count >= 2);
  const single = matches.filter(({ count }) => count < 2);
  const links = (items: typeof topics) =>
    items.map(({ tag, count }) => (
      <Link
        key={tag}
        href={listHref("/", { tag })}
        className={styles.chip}
        aria-label={`${tag} 주제 글 보기`}
        title={topicVariants(tag).join(" · ")}
      >
        <span>#{tag}</span>
        <span className={styles.count} aria-label={`공개 글 ${count}개`}>
          {count}
        </span>
      </Link>
    ));
  return (
    <section className={styles.index} aria-labelledby="all-topics-title">
      <div className={styles.search}>
        <h2 id="all-topics-title">모든 주제 {topics.length}개</h2>
        <label htmlFor="topic-name">주제 이름 찾기</label>
        <input
          id="topic-name"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="도구·환경·방법 이름"
        />
      </div>
      <nav aria-label="주제" className={styles.topics}>
        {needle ? (
          links(matches)
        ) : (
          <>
            {links(frequent)}
            {!!single.length && (
              <details className={styles.more}>
                <summary>한 번만 쓰인 주제 {single.length}개 더 보기</summary>
                <div className={styles.topics}>{links(single)}</div>
              </details>
            )}
          </>
        )}
      </nav>
      {!matches.length && (
        <p role="status">
          ‘{query.trim()}’ 주제가 없어요.{" "}
          <Link href={listHref("/", { query: query.trim() })}>
            글 본문에서 찾기 ›
          </Link>
        </p>
      )}
      <p className={styles.note}>
        표기만 다른 주제는 합쳐 보여요: 리버스 엔지니어링·역공학 → 리버싱,
        윈도우 → Windows. 글에 붙은 원래 표기는 그대로 둬요.
      </p>
    </section>
  );
}
