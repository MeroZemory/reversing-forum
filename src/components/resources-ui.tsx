"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PostSummary } from "@/lib/types";
import { readFeedFilters } from "@/lib/feed-navigation";
import { PostList } from "./post-list";
import styles from "./community-layout.module.css";

export function SiteEntrances({
  active,
  desktop = false,
  placement,
  openCount,
}: {
  active?: "feed" | "questions" | "resources";
  desktop?: boolean;
  placement?: "header";
  openCount?: number;
}) {
  const pathname = usePathname();
  // Entrances now belong to the shared header. Legacy page call sites stay
  // compatible while independently owned screens migrate, without a second nav.
  if (!desktop && placement !== "header") return null;
  const current =
    active ??
    (pathname === "/questions"
      ? "questions"
      : pathname.startsWith("/resources")
        ? "resources"
        : pathname === "/"
          ? "feed"
          : undefined);
  return (
    <nav
      className={desktop ? styles.desktopNav : styles.subNav}
      aria-label="사이트 둘러보기"
    >
      <Link href="/" aria-current={current === "feed" ? "page" : undefined}>
        최신 글
      </Link>
      <Link
        href="/questions"
        aria-label="답을 기다리는 질문"
        aria-current={current === "questions" ? "page" : undefined}
      >
        <span className={styles.longNav}>답을 기다리는 질문</span>
        <span className={styles.shortNav}>답 기다림</span>
        {!desktop && openCount !== undefined && (
          <span aria-hidden="true" className={styles.navCount}>
            {openCount}
          </span>
        )}
      </Link>
      <Link
        href="/resources"
        aria-current={current === "resources" ? "page" : undefined}
      >
        주제
      </Link>
    </nav>
  );
}
export function SubNav({ openCount }: { openCount?: number }) {
  return <SiteEntrances placement="header" openCount={openCount} />;
}
export function ResourcePostList({
  posts,
  from,
  basePath,
}: {
  posts: PostSummary[];
  from: string;
  basePath: string;
}) {
  const filters = readFeedFilters(
    Object.fromEntries(
      new URL(from, "https://reversing-all.invalid").searchParams,
    ),
  );
  return (
    <PostList
      posts={posts}
      filters={filters}
      from={from}
      basePath={basePath}
      answer={basePath === "/questions"}
    />
  );
}
