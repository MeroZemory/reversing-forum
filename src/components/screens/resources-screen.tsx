import Link from "next/link";
import type { ResourcesScreenData } from "@/contracts/screens";
import { FeedScreen } from "./feed-screen";
import { PostLink } from "../feed-navigation";

export function ResourcesScreen({ data }: { data: ResourcesScreenData }) {
  return (
    <FeedScreen
      data={data.feed}
      guideContent={
        <section
          className="resource-guide-intro"
          aria-labelledby={data.selected ? undefined : "resource-title"}
        >
          {data.selected ? (
            <Link className="back-link" href="/resources">
              자료 길잡이 전체 보기
            </Link>
          ) : (
            <>
              <h1 id="resource-title">자료 길잡이</h1>
              <p>
                운영자가 주제별로 연결한 공개 글입니다. 조건·과정·한계를 함께
                읽고, 질문과 댓글로 내용을 보완해 주세요.
              </p>
              <p className="resource-guide-note">
                회원 글과 편집 글을 같은 기준으로 연결합니다. 일부 결과나 의견,
                정정이 필요한 내용도 함께 다루며, 정확성을 인증하는 목록은
                아닙니다.
              </p>
              <div className="resource-guides">
                {data.guides.map((guide) => (
                  <section className="resource-guide" key={guide.slug}>
                    <h2>
                      <Link href={`/resources/${guide.slug}`}>
                        {guide.title}
                      </Link>
                    </h2>
                    <p>{guide.description}</p>
                    <ul>
                      {guide.posts.map((post) => (
                        <li key={post.id}>
                          <PostLink
                            id={post.id}
                            title={post.title}
                            from={data.feed.from}
                          />
                        </li>
                      ))}
                    </ul>
                    <Link
                      className="resource-guide-all"
                      href={`/resources/${guide.slug}`}
                    >
                      연결된 글 {guide.count}개 모두 보기
                    </Link>
                  </section>
                ))}
              </div>
              {!data.guides.length && (
                <p>
                  아직 연결할 공개 글이 없습니다. 공개 글이 준비되면 길잡이에
                  표시됩니다.
                </p>
              )}
            </>
          )}
        </section>
      }
    />
  );
}
