import "server-only";
import { listPostPage } from "./forum";
import { readFeedFilters } from "@/lib/feed-navigation";
import type { SearchParams, ResourceGuide } from "@/contracts/screens";
import type { PostSummary } from "@/lib/types";

// Operator-curated topic rules, not a popularity-based taxonomy. Matching is
// independent of author, purpose, accuracy or completeness of the public post.
const guideSeeds = [
  {
    slug: "learning",
    title: "학습 시작",
    description:
      "학습 순서와 기초 개념을 살피고, 직접 풀어 볼 방법을 찾습니다.",
    match: /학습|입문|초심자|문제 풀이|학습 방법|stdio|전처리기|소스 코드/i,
  },
  {
    slug: "executables",
    title: "실행 파일 분석",
    description:
      "분기·함수·메모리를 관찰하는 과정과 분석의 한계를 함께 읽습니다.",
    match:
      /실행 파일|바이너리|DLL|\bPE\b|패킹|디버깅|디버거|동적 분석|함수 분석|레지스터|JMP|Ghidra|IDA|OllyDbg/i,
  },
  {
    slug: "systems",
    title: "시스템과 네트워크",
    description: "스택·인터럽트와 네트워크 동작을 설명하는 글을 연결합니다.",
    match: /스택|인터럽트|운영체제|네트워크|라우터|브로드캐스트/i,
  },
  {
    slug: "devices",
    title: "모바일과 펌웨어",
    description: "안드로이드와 임베디드 환경의 학습·분석 조건을 살펴봅니다.",
    match: /안드로이드|APK|모바일|펌웨어|임베디드|ARM\b/i,
  },
] as const;

// Initial operator selection: approved public IDs only. New matching member
// and editorial posts join through explicit persisted operator curation.
export const curatedPostIds = [
  "c15bc400-b67c-4803-aaa4-5f1c9b71b678",
  "2ce239d2-fb37-457c-a9ed-08bbf37fb67e",
  "75d54a3b-dce6-4710-8457-49917caaa923",
  "ef552352-9d13-41d9-b089-5640a3b6098e",
  "41f68746-ef0b-478a-9922-cd0e2975a15b",
  "83b3450b-af93-428c-870e-5894bfc4002c",
  "f09f8fc2-784c-47ad-ae89-a70e4e2aeb20",
  "11bfccaa-a5e8-4b79-9cba-6b40f27c139a",
  "6dacaec9-8878-409d-8740-bf6473552fde",
  "a43b647e-6fdf-4d91-8f1f-39f3005da5ba",
  "1072389e-1951-4d06-ba4f-ec7865d4fd21",
  "b9627a8a-f195-44c1-b545-5f085739b168",
  "35126997-b83e-4281-ab12-29c3c13b30be",
  "53817942-9e7f-409b-b83a-8594094b980d",
  "d075f006-7221-4e57-a256-b66e57b6d0a8",
] as const;

export function eligibleResourceGuides(
  post: Pick<PostSummary, "title" | "tags">,
): string[] {
  return guideSeeds
    .filter(({ match }) => match.test([post.title, ...post.tags].join(" ")))
    .map(({ slug }) => slug);
}

export type ResourceSelection = ReadonlyMap<string, readonly string[]>;

// Reuse the existing public-only query; never read private editorial stores.
// Paging avoids the legacy listPosts 100-item cap.
export function listResourcePosts(params: SearchParams = {}): PostSummary[] {
  const filters = readFeedFilters(params);
  const first = listPostPage({ ...filters, page: 1, pageSize: 100 });
  const posts = [...first.posts];
  for (let page = 2; page <= first.pageCount; page++) {
    posts.push(...listPostPage({ ...filters, page, pageSize: 100 }).posts);
  }
  return posts;
}

export function resourceGuides(
  posts: PostSummary[],
  selectedIds: readonly string[] | ResourceSelection = curatedPostIds,
): ResourceGuide[] {
  const selected = Array.isArray(selectedIds) ? new Set(selectedIds) : null;
  return guideSeeds.flatMap(({ match, ...seed }) => {
    const linked = posts.filter(
      (post) =>
        (selected
          ? selected.has(post.id)
          : (selectedIds as ResourceSelection)
              .get(post.id)
              ?.includes(seed.slug)) &&
        match.test([post.title, ...post.tags].join(" ")),
    );
    return linked.length
      ? [{ ...seed, count: linked.length, posts: linked }]
      : [];
  });
}
