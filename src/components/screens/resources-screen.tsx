import Link from "next/link";
import { Plus } from "lucide-react";
import { ActionLink } from "../ui/action";
import communityStyles from "../community-layout.module.css";
import type { ResourcesScreenData } from "@/contracts/screens";
import { FeedScreen } from "./feed-screen";
import { SiteEntrances } from "../resources-ui";
import { FeedScrollRestoration } from "../feed-navigation";
import { GuideCard } from "../guide-card";
import { TopicFilter } from "../topic-filter";
import styles from "./resources-screen.module.css";

// Empty cards describe the existing guides; they never add curated posts.
const guideFrames = [
  {
    slug: "learning",
    title: "학습 시작",
    description: "학습 순서와 기초 개념을 살피고, 직접 풀어 볼 방법을 찾아요.",
  },
  {
    slug: "executables",
    title: "실행 파일 분석",
    description:
      "분기·함수·메모리를 관찰하는 과정과 분석의 한계를 함께 읽어요.",
  },
  {
    slug: "systems",
    title: "시스템과 네트워크",
    description: "스택·인터럽트와 네트워크 동작을 설명하는 글을 연결해요.",
  },
  {
    slug: "devices",
    title: "모바일과 펌웨어",
    description: "안드로이드와 임베디드 환경의 학습·분석 조건을 살펴봐요.",
  },
];

export function ResourcesScreen({ data }: { data: ResourcesScreenData }) {
  const filters = data.feed.filters;
  if (
    data.selected ||
    filters.query ||
    filters.tag ||
    filters.purpose ||
    filters.open ||
    (filters.page ?? 1) > 1
  )
    return (
      <FeedScreen
        data={data.feed}
        guideContent={
          <Link className={styles.back} href="/resources">
            ‹ 주제
          </Link>
        }
      />
    );
  return (
    <div className={`shell ${styles.screen}`}>
      <FeedScrollRestoration href={data.feed.from} />
      <SiteEntrances active="resources" />
      <div className={styles.heading}>
        <h1>주제</h1>
        <div className={communityStyles.feedWrite}>
          <ActionLink size="compact" href={data.feed.writeHref}>
            <Plus size={16} aria-hidden="true" />글 쓰기
          </ActionLink>
        </div>
      </div>
      <p className={styles.intro}>
        운영자가 고른 길잡이로 시작하거나, 글에 붙은 주제로 찾아보세요.
      </p>
      <section aria-labelledby="guide-title">
        <div className={styles.heading}>
          <h2 id="guide-title">길잡이</h2>
          <p>
            운영자가 공개 글을 확인하고 묶었어요 · 정확성 인증 목록은 아니에요
          </p>
        </div>
        <p className={styles.intro}>
          회원 글과 편집 글을 같은 기준으로 연결해요. 일부 결과나 의견, 정정이
          필요한 내용도 함께 다뤄요.
        </p>
        <div className={styles.guides}>
          {guideFrames.map((frame) => {
            const guide = data.guides.find((item) => item.slug === frame.slug);
            return (
              <GuideCard
                key={frame.slug}
                guide={guide ?? { ...frame, count: 0, posts: [] }}
                from={data.feed.from}
              />
            );
          })}
        </div>
        {!data.guides.length && (
          <p>
            아직 연결할 공개 글이 없어요. 공개 글이 준비되면 길잡이에 표시돼요.
          </p>
        )}
      </section>
      <TopicFilter topics={data.topics} />
    </div>
  );
}
