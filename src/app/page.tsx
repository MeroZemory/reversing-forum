import type { Metadata } from "next";
import Link from "next/link";
import Form from "next/form";
import {
  Plus,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { listPostPage, listPublicTopics } from "@/server/forum";
import { purposeLabels } from "@/lib/types";
import { feedHref, feedPurposes, readFeedFilters } from "@/lib/feed-navigation";
import { PostList } from "@/components/post-list";
import { FeedScrollRestoration } from "@/components/feed-navigation";
import { ActionLink } from "@/components/ui/action";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({
  searchParams,
}: Props): Promise<Metadata> {
  const filters = readFeedFilters(await searchParams);
  const filtered = !!(
    filters.purpose ||
    filters.tag ||
    filters.query ||
    (filters.page ?? 1) > 1
  );
  return {
    alternates: { canonical: "/" },
    ...(filtered
      ? { title: "글 찾아보기", robots: { index: false, follow: true } }
      : {}),
  };
}

export default async function Home({ searchParams }: Props) {
  const filters = readFeedFilters(await searchParams);
  const result = listPostPage(filters);
  const topics = listPublicTopics(12);
  const current = { ...filters, page: result.page };
  const from = feedHref(current);
  const { purpose, tag, query } = filters;
  const heading = query
    ? "검색 결과"
    : tag
      ? `${tag} 주제`
      : purpose
        ? `${purposeLabels[purpose]} 글`
        : "최신 글";
  const writeParams = new URLSearchParams({ from });
  if (purpose) writeParams.set("purpose", purpose);
  if (tag) writeParams.set("tag", tag);

  return (
    <div className="shell home-shell">
      <FeedScrollRestoration href={from} />
      <div className="community-layout">
        <section className="forum-feed" aria-labelledby="forum-title">
          <div className="forum-heading">
            <div>
              <h1 id="forum-title">{heading}</h1>
              <p className="feed-intro">
                {tag
                  ? "이 주제가 붙은 글을 목적과 검색어로 좁혀 보세요."
                  : "질문하고, 분석 과정과 작업법을 함께 남겨 주세요."}
              </p>
            </div>
            <ActionLink size="compact" href={`/new?${writeParams}`}>
              <Plus size={16} aria-hidden="true" />글 쓰기
            </ActionLink>
          </div>
          <div className="forum-controls">
            <nav className="filter-tabs" aria-label="글 목적">
              <Link
                href={feedHref({ ...filters, purpose: undefined, page: 1 })}
                scroll={false}
                className={!purpose ? "active" : ""}
                aria-current={!purpose ? "page" : undefined}
              >
                전체
              </Link>
              {feedPurposes.map((item) => (
                <Link
                  key={item}
                  href={feedHref({ ...filters, purpose: item, page: 1 })}
                  scroll={false}
                  className={purpose === item ? "active" : ""}
                  aria-current={purpose === item ? "page" : undefined}
                >
                  {purposeLabels[item]}
                </Link>
              ))}
            </nav>
            <Form
              className="search-form"
              action="/"
              scroll={false}
              role="search"
            >
              {purpose && (
                <input type="hidden" name="purpose" value={purpose} />
              )}
              {tag && <input type="hidden" name="tag" value={tag} />}
              <Search size={16} aria-hidden="true" />
              <input
                key={query || ""}
                aria-label="글 검색"
                name="q"
                defaultValue={query || ""}
                placeholder={tag ? `${tag} 글에서 검색` : "제목·본문·태그 검색"}
                maxLength={200}
              />
              <button type="submit">검색</button>
            </Form>
          </div>
          {topics.length > 0 && (
            <details className="topic-disclosure">
              <summary>
                주제별로 찾기
                <ChevronDown size={16} aria-hidden="true" />
              </summary>
              <nav aria-label="주제">
                {topics.map((topic) => (
                  <Link
                    key={topic.tag}
                    href={feedHref({ tag: topic.tag })}
                    aria-current={
                      tag?.toLowerCase() === topic.tag.toLowerCase()
                        ? "page"
                        : undefined
                    }
                  >
                    <span>#{topic.tag}</span>
                    <span
                      className="topic-count"
                      aria-label={`공개 글 ${topic.count}개`}
                    >
                      {topic.count}
                    </span>
                  </Link>
                ))}
              </nav>
            </details>
          )}
          {(tag || query) && (
            <div className="active-filters" aria-label="적용한 검색 조건">
              {tag && (
                <Link
                  href={feedHref({ ...filters, tag: undefined, page: 1 })}
                  scroll={false}
                  aria-label="주제 지우기"
                >
                  <span>
                    주제 <strong>#{tag}</strong>
                  </span>
                  <X size={14} aria-hidden="true" />
                </Link>
              )}
              {query && (
                <Link
                  href={feedHref({ ...filters, query: undefined, page: 1 })}
                  scroll={false}
                  aria-label="검색어 지우기"
                >
                  <span>
                    검색 <strong>{query}</strong>
                  </span>
                  <X size={14} aria-hidden="true" />
                </Link>
              )}
            </div>
          )}
          <div id="feed-results" className="list-summary">
            <span>
              공개 글 <strong>{result.total.toLocaleString("ko-KR")}</strong>개
            </span>
            <span>최신순</span>
          </div>
          <PostList posts={result.posts} filters={filters} from={from} />
          {result.pageCount > 1 && (
            <nav className="pagination" aria-label="목록 페이지">
              {result.page > 1 ? (
                <Link
                  href={`${feedHref({ ...filters, page: result.page - 1 })}#feed-results`}
                  rel="prev"
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                  이전
                </Link>
              ) : (
                <span className="page-unavailable">
                  <ChevronLeft size={16} aria-hidden="true" />
                  이전
                </span>
              )}
              <span>
                <strong>{result.page}</strong> / {result.pageCount} 페이지
              </span>
              {result.page < result.pageCount ? (
                <Link
                  href={`${feedHref({ ...filters, page: result.page + 1 })}#feed-results`}
                  rel="next"
                >
                  다음
                  <ChevronRight size={16} aria-hidden="true" />
                </Link>
              ) : (
                <span className="page-unavailable">
                  다음
                  <ChevronRight size={16} aria-hidden="true" />
                </span>
              )}
            </nav>
          )}
        </section>
        <aside className="community-sidebar" aria-label="주제와 참여 안내">
          {topics.length > 0 && (
            <section className="topic-browser" aria-labelledby="topics-title">
              <h2 id="topics-title">주제별로 찾기</h2>
              <nav aria-label="주제">
                {topics.map((topic) => (
                  <Link
                    key={topic.tag}
                    href={feedHref({ tag: topic.tag })}
                    className={
                      tag?.toLowerCase() === topic.tag.toLowerCase()
                        ? "selected-topic"
                        : undefined
                    }
                    aria-current={
                      tag?.toLowerCase() === topic.tag.toLowerCase()
                        ? "page"
                        : undefined
                    }
                  >
                    <span>#{topic.tag}</span>
                    <span
                      className="topic-count"
                      aria-label={`공개 글 ${topic.count}개`}
                    >
                      {topic.count}
                    </span>
                  </Link>
                ))}
              </nav>
            </section>
          )}
          <section className="participation-note">
            <h2>무엇을 나누나요?</h2>
            <dl>
              <div>
                <dt>질문</dt>
                <dd>막힌 지점과 시도한 내용을 남기고 함께 풀어 봅니다.</dd>
              </div>
              <div>
                <dt>공유</dt>
                <dd>분석 과정, 도구 사용법과 AI 활용 경험을 기록합니다.</dd>
              </div>
              <div>
                <dt>자유</dt>
                <dd>소식과 생각을 나누며 이야기를 이어갑니다.</dd>
              </div>
            </dl>
            <p>
              글은 누구나 읽을 수 있습니다.
              <br />
              글과 댓글 작성에는 로그인이 필요합니다.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
