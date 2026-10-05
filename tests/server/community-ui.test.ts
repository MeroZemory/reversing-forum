import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedScreenData } from "@/contracts/screens";
import type { PostSummary } from "@/lib/types";

const navigation = vi.hoisted(() => ({ path: "/", query: "" }));
const loader = vi.hoisted(() => ({ loadFeedScreen: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.path,
  useSearchParams: () => new URLSearchParams(navigation.query),
}));
vi.mock("@/server/screens", () => loader);

import { HighlightText, PostList } from "@/components/post-list";
import { FeedScreen } from "@/components/screens/feed-screen";
import { SiteHeader } from "@/components/site-header";
import { SiteEntrances } from "@/components/resources-ui";
import {
  HeaderSearch,
  HeaderWriteLink,
  readRecentSearches,
  rememberSearch,
} from "@/components/header-search";
import Questions, { metadata } from "@/app/questions/page";

const post: PostSummary = {
  id: "question-1",
  title: "Windows <script> 분석",
  excerpt: "IDA에서 Windows 호출을 확인했어요.",
  kind: "question",
  tags: ["역공학", "리버싱", "윈도우", "IDA Pro"],
  author: { id: "editor", name: "자료편집 운영계정", role: "editor" },
  createdAt: "2026-10-05T01:00:00Z",
  commentCount: 0,
  recordPeriod: "2018년 10월",
  sourceCount: 3,
};
function feed(overrides: Partial<FeedScreenData> = {}): FeedScreenData {
  return {
    basePath: "/",
    filters: {},
    result: { posts: [post], total: 1, page: 1, pageSize: 30, pageCount: 1 },
    topics: [],
    openCount: 1,
    openPreview: [post],
    topTopics: [{ tag: "Windows", count: 9 }],
    purposeCounts: { question: 1, share: 2, discussion: 3 },
    from: "/",
    writeHref: "/new?from=%2F",
    ...overrides,
  };
}
afterEach(() => {
  navigation.path = "/";
  navigation.query = "";
  vi.unstubAllGlobals();
});

describe("community UI handoff", () => {
  it("sends the unfiltered topic index header search to the visible feed results", () => {
    navigation.path = "/resources";
    const html = renderToStaticMarkup(
      createElement(HeaderSearch, { topics: [] }),
    );
    expect(html).toContain('action="/"');
    expect(html).not.toContain('action="/resources"');
  });
  it("highlights literal text while escaping HTML and regexp metacharacters", () => {
    const html = renderToStaticMarkup(
      createElement(HighlightText, {
        text: "<script>.*.*</script>",
        query: ".*",
      }),
    );
    expect(html).toBe(
      "&lt;script&gt;<mark>.*</mark><mark>.*</mark>&lt;/script&gt;",
    );
    expect(
      renderToStaticMarkup(
        createElement(HighlightText, {
          text: "Windows WINDOWS",
          query: "windows",
        }),
      ),
    ).toBe("<mark>Windows</mark> <mark>WINDOWS</mark>");
  });
  it("renders editorial metadata and canonical topics once without web dates, account badges or zero comments", () => {
    const html = renderToStaticMarkup(
      createElement(PostList, {
        posts: [post],
        filters: { query: "Windows" },
        from: "/questions?purpose=question&open=1",
        answer: true,
      }),
    );
    expect(html).toContain("2018년 10월 카톡 기록");
    expect(html).toContain("보충 출처 3");
    expect(html).toContain("답 기다림");
    expect(html).toContain("<mark>Windows</mark>");
    expect(html).toContain("#answers");
    expect(html).toContain("from=%2Fquestions%3Fpurpose%3Dquestion%26open%3D1");
    expect(html.match(/#리버싱/g)).toHaveLength(1);
    expect(html).not.toContain("운영계정");
    expect(html).not.toContain("2026-10-05");
    expect(html).not.toContain("댓글 0");
  });
  it("keeps real member names and dates and displays a nonzero answer count once", () => {
    const html = renderToStaticMarkup(
      createElement(PostList, {
        posts: [
          {
            ...post,
            recordPeriod: undefined,
            sourceCount: undefined,
            author: { id: "member", name: "회원" },
            commentCount: 2,
          },
        ],
      }),
    );
    expect(html).toContain("회원");
    expect(html).toContain("2026-10-05T01:00:00Z");
    expect(html.match(/답변 2/g)).toHaveLength(1);
    expect(html).not.toContain("댓글 2");
  });
  it("uses only question-topic DTOs for the eight question chips", () => {
    const html = renderToStaticMarkup(
      createElement(FeedScreen, {
        data: feed({
          basePath: "/questions",
          filters: { purpose: "question", open: true },
          questionTopics: Array.from({ length: 9 }, (_, index) => ({
            tag: `질문주제${index}`,
            count: index + 1,
          })),
        }),
      }),
    );
    expect(html).toContain("#질문주제7");
    expect(html).not.toContain("#질문주제8");
    expect(html).toContain('aria-hidden="true">8</span>');
  });
  it("renders the home path as a feed with purpose counts and three sidebar boxes", () => {
    const html = renderToStaticMarkup(
      createElement(FeedScreen, { data: feed() }),
    );
    expect(html).toContain('id="forum-title">최신 글');
    expect(html).toContain("IDA에서 Windows 호출");
    expect(html).toContain('aria-hidden="true">6</span>');
    expect(html).toContain("무엇을 나누나요?");
    expect(html.match(/<section/g)).toHaveLength(4);
    expect(html).not.toContain("주제별로 찾기");
  });
  it("offers an encoded question title and condition clearing for a query-only empty result", () => {
    const html = renderToStaticMarkup(
      createElement(PostList, { posts: [], filters: { query: "C++ & IDA" } }),
    );
    expect(html).toContain(
      "/new?purpose=question&amp;title=C%2B%2B%20%26%20IDA",
    );
    expect(html).toContain("‘C++ &amp; IDA’로 질문하기");
    expect(html).toContain("모든 조건 지우기");
  });
  it("links a searched alias to the complete public topic even outside prepared top topics", () => {
    const html = renderToStaticMarkup(
      createElement(FeedScreen, {
        data: feed({
          filters: { query: "윈도우" },
          topTopics: [],
          matchingTopic: { tag: "Windows", count: 9 },
        }),
      }),
    );
    expect(html).toContain("#Windows 주제 글 9개 모두 보기");
    expect(html).toContain("관련도순");
  });
  it("forces question purpose and open regardless of malicious search params and keeps noindex follow", async () => {
    loader.loadFeedScreen.mockReturnValue(
      feed({
        basePath: "/questions",
        filters: { purpose: "question", open: true },
      }),
    );
    const screen = await Questions({
      searchParams: Promise.resolve({
        purpose: ["share", "discussion"],
        open: "0",
        q: "IDA",
      }),
    });
    expect(loader.loadFeedScreen).toHaveBeenLastCalledWith(
      { purpose: "question", open: "0", q: "IDA" },
      { basePath: "/questions", open: true, title: "답을 기다리는 질문" },
    );
    expect(renderToStaticMarkup(screen)).toContain("#answers");
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });
  it("has a single login and registration link and preserves the existing brand", () => {
    const html = renderToStaticMarkup(
      createElement(SiteHeader, {
        viewer: null,
        logoutControl: null,
        topics: [{ tag: "Windows", count: 9 }],
        openCount: 12,
      }),
    );
    expect(html.match(/href="\/login"/g)).toHaveLength(1);
    expect(html.match(/href="\/register"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Reversing All 홈"');
    expect(html).toContain('aria-label="사이트 둘러보기"');
    expect(html).not.toContain('aria-label="주요 메뉴"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(">12</span>");
  });
  it("keeps one member destination and avoids the legacy page navigation duplicate", () => {
    const html = renderToStaticMarkup(
      createElement(SiteHeader, {
        viewer: { id: "member", name: "회원" },
        logoutControl: null,
      }),
    );
    expect(html.match(/href="\/me"/g)).toHaveLength(1);
    expect(
      renderToStaticMarkup(
        createElement(SiteEntrances, { active: "resources" }),
      ),
    ).toBe("");
  });
  it("preserves filter and write context in the desktop header", () => {
    navigation.path = "/resources/learning";
    navigation.query = "purpose=share&tag=IDA&page=2&q=API";
    const search = renderToStaticMarkup(
      createElement(HeaderSearch, { topics: [] }),
    );
    expect(search).toContain('action="/resources/learning"');
    expect(search).toContain('name="purpose" value="share"');
    expect(search).toContain('name="tag" value="IDA"');
    expect(search).toContain('aria-label="글 검색"');
    const write = renderToStaticMarkup(createElement(HeaderWriteLink));
    expect(write).toContain("purpose=share&amp;tag=IDA");
    expect(write).toContain("%2Fresources%2Flearning");
  });
  it("keeps recent searches local, bounded and usable when storage fails", () => {
    expect(readRecentSearches("not-json")).toEqual([]);
    expect(readRecentSearches('{"q":"private"}')).toEqual([]);
    expect(
      readRecentSearches(
        JSON.stringify([
          " IDA ",
          "IDA",
          1,
          "",
          "PE",
          "IAT",
          "OEP",
          "API",
          "extra",
        ]),
      ),
    ).toEqual(["IDA", "PE", "IAT", "OEP", "API"]);
    const storage = { getItem: () => '["IDA","PE"]', setItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    rememberSearch(" PE ");
    expect(storage.setItem).toHaveBeenCalledWith(
      "reversing-all:recent-searches",
      '["PE","IDA"]',
    );
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => rememberSearch("IDA")).not.toThrow();
  });
});
