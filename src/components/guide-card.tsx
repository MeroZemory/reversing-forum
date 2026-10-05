import Link from "next/link";
import type { ResourceGuide } from "@/contracts/screens";
import { PostLink } from "./feed-navigation";
import styles from "./guide-card.module.css";

export function GuideCard({
  guide,
  from,
}: {
  guide: ResourceGuide;
  from: string;
}) {
  return (
    <section className={styles.card}>
      <h3>
        {guide.count ? (
          <Link href={`/resources/${guide.slug}`}>{guide.title}</Link>
        ) : (
          <span className={styles.title}>{guide.title}</span>
        )}
        <span>공개 글 {guide.count}개</span>
      </h3>
      <p>{guide.description}</p>
      {guide.posts.length ? (
        <ul>
          {guide.posts.map((post) => (
            <li key={post.id}>
              <PostLink id={post.id} title={post.title} from={from} />
            </li>
          ))}
        </ul>
      ) : (
        <p>
          아직 연결할 공개 글이 없어요. 공개 글이 준비되면 길잡이에 표시돼요.
        </p>
      )}
      {guide.count > 0 && (
        <Link className={styles.all} href={`/resources/${guide.slug}`}>
          연결된 글 {guide.count}개 모두 보기 ›
        </Link>
      )}
    </section>
  );
}
