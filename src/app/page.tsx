import Link from "next/link";
import Form from "next/form";
import { Plus, Search } from "lucide-react";
import { listPosts } from "@/server/forum";
import { kindLabels, postKinds, type PostKind } from "@/lib/types";
import { PostList } from "@/components/post-list";
import { ActionLink } from "@/components/ui/action";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; q?: string }>;
}) {
  const params = await searchParams;
  const kind = postKinds.includes(params.kind as PostKind)
    ? (params.kind as PostKind)
    : undefined;
  const query = (params.q || "").trim().slice(0, 200);
  const posts = listPosts({ kind, query });

  function filterHref(nextKind?: PostKind) {
    const filters = new URLSearchParams();
    if (nextKind) filters.set("kind", nextKind);
    if (query) filters.set("q", query);
    return filters.size ? `/?${filters}` : "/";
  }

  return (
    <div className="shell home-shell">
      <section className="forum-feed" aria-labelledby="forum-title">
        <div className="forum-heading">
          <h1 id="forum-title">
            {kind ? `${kindLabels[kind]} 글` : "최신 글"}
          </h1>
          <ActionLink size="compact" href="/new">
            <Plus size={16} aria-hidden="true" /> 글 쓰기
          </ActionLink>
        </div>
        <div className="forum-controls">
          <nav className="filter-tabs" aria-label="글 유형">
            <Link
              href={filterHref()}
              scroll={false}
              className={!kind ? "active" : ""}
              aria-current={!kind ? "page" : undefined}
            >
              전체
            </Link>
            {postKinds.map((item) => (
              <Link
                key={item}
                href={filterHref(item)}
                scroll={false}
                className={kind === item ? "active" : ""}
                aria-current={kind === item ? "page" : undefined}
              >
                {kindLabels[item]}
              </Link>
            ))}
          </nav>
          <Form className="search-form" action="/" scroll={false} role="search">
            {kind && <input type="hidden" name="kind" value={kind} />}
            <Search size={16} aria-hidden="true" />
            <input
              key={query}
              aria-label="글 검색"
              name="q"
              defaultValue={query}
              placeholder="글 검색"
              maxLength={200}
            />
            <button type="submit">검색</button>
          </Form>
        </div>
        {query && (
          <p className="search-summary">
            “{query}” 검색 결과{" "}
            <Link href={kind ? `/?kind=${kind}` : "/"} scroll={false}>
              검색어 지우기
            </Link>
          </p>
        )}
        <PostList posts={posts} kind={kind} query={query} />
      </section>
    </div>
  );
}
