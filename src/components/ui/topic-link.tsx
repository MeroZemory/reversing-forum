import Link from "next/link";
import { feedHref } from "@/lib/feed-navigation";

export function TopicLink({
  tag,
  compact = false,
}: {
  tag: string;
  compact?: boolean;
}) {
  return (
    <Link
      className={compact ? "topic-inline" : "tag"}
      href={feedHref({ tag })}
      aria-label={`${tag} 주제 글 보기`}
    >
      #{tag}
    </Link>
  );
}
