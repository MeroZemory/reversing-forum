import Link from "next/link";
import type { ReactNode } from "react";
import { Plus, X, ChevronLeft, ChevronRight } from "lucide-react";
import type { FeedScreenData } from "@/contracts/screens";
import { purposeLabels } from "@/lib/types";
import { feedPurposes, type FeedFilters } from "@/lib/feed-navigation";
import { listHref } from "@/lib/resource-navigation";
import { canonicalTopic, topicVariants } from "@/lib/topic-aliases";
import { PostList } from "../post-list";
import { FeedScrollRestoration, PostLink } from "../feed-navigation";
import { SearchBox } from "../header-search";
import { ActionLink } from "../ui/action";
import styles from "../community-layout.module.css";

export function FeedScreen({
  data,
  guideContent,
}: {
  data: FeedScreenData;
  guideContent?: ReactNode;
}) {
  const { filters, result, from, writeHref } = data;
  const { purpose, tag, query } = filters;
  const basePath = data.basePath ?? "/";
  const questions = basePath === "/questions";
  const href = (values: FeedFilters = {}) =>
    listHref(
      basePath,
      questions ? { ...values, purpose: "question", open: true } : values,
    );
  const heading = query
    ? `‘${query}’ 검색 결과`
    : tag
      ? `#${canonicalTopic(tag)}${questions ? " 질문" : " 주제"}`
      : questions
        ? (data.title ?? "답을 기다리는 질문")
        : purpose
          ? `${purposeLabels[purpose]} 글`
          : (data.title ?? "최신 글");
  const matchingTopic = query ? data.matchingTopic : undefined;
  return (
    <div className={`shell ${styles.page}`}>
      <FeedScrollRestoration href={from} />
      {guideContent}
      <div className={styles.layout}>
        <section className={styles.feed} aria-labelledby="forum-title">
          {query && (
            <SearchBox
              className={styles.mobileResultsSearch}
              action={basePath}
              query={query}
              tag={tag}
              purpose={purpose}
              open={filters.open}
            />
          )}
          {tag && (
            <Link className={styles.backTopics} href="/resources">
              ‹ 주제
            </Link>
          )}
          <div className={styles.heading}>
            <div>
              {guideContent && basePath === "/resources" ? (
                <h2 id="forum-title">{heading}</h2>
              ) : (
                <h1 id="forum-title">{heading}</h1>
              )}
              <p>
                {data.intro ??
                  (questions
                    ? "아직 답이 없는 질문이에요. 아는 만큼 함께 풀어 주세요."
                    : tag
                      ? "이 주제가 붙은 글을 목적과 검색어로 좁혀 보세요."
                      : "질문하고, 분석 과정과 작업법을 함께 남겨 주세요.")}
              </p>
              {tag && topicVariants(tag).length > 1 && (
                <p>{topicVariants(tag).join(" · ")} 표기를 함께 찾아요.</p>
              )}
            </div>
            <div className={styles.feedWrite}>
              <ActionLink size="compact" href={writeHref}>
                <Plus size={16} aria-hidden="true" />글 쓰기
              </ActionLink>
            </div>
          </div>
          {matchingTopic && (
            <Link
              className={styles.topicMatch}
              href={href({ tag: matchingTopic.tag })}
            >
              #{canonicalTopic(matchingTopic.tag)} 주제 글 {matchingTopic.count}
              개 모두 보기
            </Link>
          )}
          {questions ? (
            <nav className={styles.questionTopics} aria-label="질문 주제">
              <Link
                href={href()}
                scroll={false}
                aria-current={!tag ? "page" : undefined}
              >
                전체 <span aria-hidden="true">{data.openCount}</span>
              </Link>
              {(data.questionTopics ?? []).slice(0, 8).map((topic) => (
                <Link
                  key={topic.tag}
                  href={href({ ...filters, tag: topic.tag, page: 1 })}
                  scroll={false}
                  aria-current={
                    tag && canonicalTopic(tag) === canonicalTopic(topic.tag)
                      ? "page"
                      : undefined
                  }
                >
                  #{canonicalTopic(topic.tag)}{" "}
                  <span aria-hidden="true">{topic.count}</span>
                </Link>
              ))}
            </nav>
          ) : (
            <nav className={styles.filters} aria-label="글 목적">
              <Link
                href={href({ ...filters, purpose: undefined, page: 1 })}
                scroll={false}
                aria-current={!purpose ? "page" : undefined}
              >
                전체{" "}
                <span aria-hidden="true">
                  {feedPurposes.reduce(
                    (sum, item) => sum + data.purposeCounts[item],
                    0,
                  )}
                </span>
              </Link>
              {feedPurposes.map((item) => (
                <Link
                  key={item}
                  href={href({ ...filters, purpose: item, page: 1 })}
                  scroll={false}
                  aria-current={purpose === item ? "page" : undefined}
                >
                  {purposeLabels[item]}{" "}
                  <span aria-hidden="true">{data.purposeCounts[item]}</span>
                </Link>
              ))}
            </nav>
          )}
          {(tag || query) && (
            <div className={styles.activeFilters} aria-label="적용한 검색 조건">
              {tag && (
                <Link
                  href={href({ ...filters, tag: undefined, page: 1 })}
                  scroll={false}
                  aria-label="주제 지우기"
                >
                  주제 <strong>#{canonicalTopic(tag)}</strong>
                  <X size={14} aria-hidden="true" />
                </Link>
              )}
              {query && (
                <Link
                  href={href({ ...filters, query: undefined, page: 1 })}
                  scroll={false}
                  aria-label="검색어 지우기"
                >
                  검색 <strong>{query}</strong>
                  <X size={14} aria-hidden="true" />
                </Link>
              )}
            </div>
          )}
          <div id="feed-results" className={styles.summary}>
            <span>
              {data.compactEditorial
                ? "전체 공개 글 "
                : questions
                  ? "질문 "
                  : "공개 글 "}
              <strong>{result.total.toLocaleString("ko-KR")}</strong>개
            </span>
            <span>{query ? "관련도순" : "최신순"}</span>
          </div>
          {data.compactEditorial && data.compactEditorial.total > 0 && (
            <section
              className={styles.bundle}
              aria-labelledby="editorial-bundle-title"
            >
              <h2 id="editorial-bundle-title">새로 정리한 편집 자료</h2>
              <p>
                댓글이 없는 편집 글 {data.compactEditorial.total}개를
                묶었습니다.
              </p>
              <PostList posts={data.compactEditorial.posts} from={from} />
              <Link href="/resources">자료 전체 보기</Link>
            </section>
          )}
          {data.compactEditorial && (
            <p className={styles.summary}>
              회원 글과 댓글이 있는 편집 글{" "}
              {data.compactEditorial.activityTotal}개
            </p>
          )}
          {data.compactEditorial && !result.posts.length ? (
            <div className={styles.empty}>
              <p>
                아직 회원 글이나 댓글이 있는 글이 없습니다. 자료를 읽고 궁금한
                점을 남겨 주세요.
              </p>
            </div>
          ) : (
            <PostList
              posts={result.posts}
              filters={filters}
              from={from}
              basePath={basePath}
              answer={questions}
            />
          )}
          {result.pageCount > 1 && (
            <nav className={styles.pagination} aria-label="목록 페이지">
              {result.page > 1 ? (
                <Link
                  href={`${href({ ...filters, page: result.page - 1 })}#feed-results`}
                  scroll={false}
                  rel="prev"
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                  이전
                </Link>
              ) : (
                <span aria-disabled="true">
                  <ChevronLeft size={16} aria-hidden="true" />
                  이전
                </span>
              )}
              <span>
                <strong>{result.page}</strong> / {result.pageCount}
              </span>
              {result.page < result.pageCount ? (
                <Link
                  href={`${href({ ...filters, page: result.page + 1 })}#feed-results`}
                  scroll={false}
                  rel="next"
                >
                  다음
                  <ChevronRight size={16} aria-hidden="true" />
                </Link>
              ) : (
                <span aria-disabled="true">
                  다음
                  <ChevronRight size={16} aria-hidden="true" />
                </span>
              )}
            </nav>
          )}
        </section>
        <aside className={styles.aside} aria-label="커뮤니티 안내">
          {!questions && (
            <section className={styles.box}>
              <h2>
                답을 기다리는 질문{" "}
                <Link href="/questions">{data.openCount}개 모두 보기</Link>
              </h2>
              <ul className={styles.mini}>
                {data.openPreview.slice(0, 5).map((post) => (
                  <li key={post.id}>
                    <PostLink id={post.id} title={post.title} from={from} />
                    {post.recordPeriod && (
                      <span>{post.recordPeriod} 카톡 기록</span>
                    )}
                  </li>
                ))}
              </ul>
              {!data.openCount && <p>답을 기다리는 질문이 없어요.</p>}
            </section>
          )}
          <section className={styles.box}>
            <h2>
              주제 <Link href="/resources">모두 보기</Link>
            </h2>
            <nav className={styles.topicCloud} aria-label="주제">
              {data.topTopics.slice(0, 14).map((topic) => (
                <Link
                  key={topic.tag}
                  href={href({ tag: topic.tag })}
                  scroll={false}
                  aria-current={
                    tag && canonicalTopic(tag) === canonicalTopic(topic.tag)
                      ? "page"
                      : undefined
                  }
                >
                  #{canonicalTopic(topic.tag)}{" "}
                  <span aria-label={`공개 글 ${topic.count}개`}>
                    {topic.count}
                  </span>
                </Link>
              ))}
            </nav>
          </section>
          <section className={styles.box}>
            <h2>무엇을 나누나요?</h2>
            <dl>
              <dt>질문</dt>
              <dd>막힌 지점과 시도한 내용을 남기고 함께 풀어 봐요.</dd>
              <dt>공유</dt>
              <dd>분석 과정, 도구 사용법과 AI 활용 경험을 기록해요.</dd>
              <dt>자유</dt>
              <dd>소식과 생각을 나누며 이야기를 이어가요.</dd>
            </dl>
            <p>
              글은 누구나 읽을 수 있어요.
              <br />
              글과 댓글 작성에는 로그인이 필요해요.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
