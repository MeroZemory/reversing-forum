import Link from "next/link";
import { feedHref } from "@/lib/feed-navigation";
import { isResourcePath, listHref } from "@/lib/resource-navigation";

export function TopicLink({
  tag,
  compact = false,
  from,
}: {
  tag: string;
  compact?: boolean;
  from?: string;
}) {
  return (
    <Link
      className={compact ? "topic-inline" : "tag"}
      href={
        from && isResourcePath(from.split("?")[0])
          ? listHref(from.split("?")[0], { tag })
          : feedHref({ tag })
      }
      aria-label={`${tag} 주제 글 보기`}
    >
      #{tag}
    </Link>
  );
}
