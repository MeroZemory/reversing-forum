"use client";
import Form from "next/form";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccountMenu } from "./account-menu";
import { Search, Plus, X } from "lucide-react";
import { readFeedFilters, safeListReturn } from "@/lib/feed-navigation";
import { isResourcePath } from "@/lib/resource-navigation";
import { canonicalTopic } from "@/lib/topic-aliases";
import styles from "./community-layout.module.css";

const recentKey = "reversing-all:recent-searches";
export function HeaderAccountLinks({
  logoutControl,
}: {
  logoutControl: ReactNode;
}) {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 359px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const myPosts = (
    <Link className={`account-link ${styles.memberLink}`} href="/me">
      내 글
    </Link>
  );
  return (
    <>
      {!compact && myPosts}
      <AccountMenu>
        {compact && (
          <Link className="account-link" href="/me">
            내 글
          </Link>
        )}
        <Link className="account-link" href="/account">
          계정 설정
        </Link>
        {logoutControl}
      </AccountMenu>
    </>
  );
}
export function AnswerLink({
  id,
  from,
  className,
}: {
  id: string;
  from: string;
  className?: string;
}) {
  return (
    <Link
      href={`/posts/${id}?from=${encodeURIComponent(from)}#answers`}
      className={className}
      onNavigate={() => {
        try {
          sessionStorage.setItem(
            `reversing-all:feed-scroll:${from}`,
            String(window.scrollY),
          );
        } catch {}
      }}
    >
      답하기
    </Link>
  );
}
export function readRecentSearches(raw: string | null): string[] {
  try {
    const values: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(values)
      ? [
          ...new Set(
            values
              .filter(
                (value): value is string =>
                  typeof value === "string" &&
                  !!value.trim() &&
                  value.length <= 200,
              )
              .map((value) => value.trim()),
          ),
        ].slice(0, 5)
      : [];
  } catch {
    return [];
  }
}
export function rememberSearch(query: string) {
  const value = query.trim().slice(0, 200);
  if (!value) return;
  try {
    localStorage.setItem(
      recentKey,
      JSON.stringify(
        [
          value,
          ...readRecentSearches(localStorage.getItem(recentKey)).filter(
            (item) => item !== value,
          ),
        ].slice(0, 5),
      ),
    );
  } catch {}
}
export function HeaderWriteLink() {
  const pathname = usePathname();
  const params = useSearchParams();
  const from = safeListReturn(pathname + (params.size ? `?${params}` : ""));
  const filters = readFeedFilters(Object.fromEntries(params));
  const writeParams = new URLSearchParams({ from });
  const purpose = pathname === "/questions" ? "question" : filters.purpose;
  if (purpose) writeParams.set("purpose", purpose);
  if (filters.tag) writeParams.set("tag", filters.tag);
  return (
    <Link className={styles.headerWrite} href={`/new?${writeParams}`}>
      <Plus size={16} aria-hidden="true" />글 쓰기
    </Link>
  );
}
export function SearchBox({
  action = "/",
  query = "",
  tag,
  purpose,
  open,
  className,
  autoFocus = false,
  onSearch,
}: {
  action?: string;
  query?: string;
  tag?: string;
  purpose?: string;
  open?: boolean;
  className?: string;
  autoFocus?: boolean;
  onSearch?: () => void;
}) {
  return (
    <Form
      className={`${styles.searchBox} ${className ?? ""}`}
      action={action}
      role="search"
      scroll={false}
      onSubmit={(event) => {
        const value = new FormData(event.currentTarget).get("q");
        if (typeof value === "string") rememberSearch(value);
        onSearch?.();
      }}
    >
      {tag && <input type="hidden" name="tag" value={tag} />}
      {purpose && <input type="hidden" name="purpose" value={purpose} />}
      {open && <input type="hidden" name="open" value="1" />}
      <Search size={16} aria-hidden="true" />
      <input
        key={query}
        type="text"
        name="q"
        aria-label="글 검색"
        defaultValue={query}
        maxLength={200}
        placeholder={
          tag ? `${canonicalTopic(tag)} 글에서 검색` : "제목·본문·주제 검색"
        }
        autoFocus={autoFocus}
      />
      <button type="submit">검색</button>
    </Form>
  );
}
export function HeaderSearch({
  topics,
  openCount,
}: {
  topics: { tag: string; count: number }[];
  openCount?: number;
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const action =
    pathname !== "/resources" && isResourcePath(pathname) ? pathname : "/";
  const filters = readFeedFilters(Object.fromEntries(params));
  const purpose = pathname === "/questions" ? "question" : filters.purpose;
  const query = params.get("q") ?? "";
  const dialog = useRef<HTMLDialogElement>(null);
  const desktop = useRef<HTMLDivElement>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [opened, setOpened] = useState(false);
  function close() {
    dialog.current?.close();
    setOpened(false);
  }
  function show() {
    try {
      setRecent(readRecentSearches(localStorage.getItem(recentKey)));
    } catch {
      setRecent([]);
    }
    setOpened(true);
    dialog.current?.showModal();
  }
  useEffect(() => {
    if (!opened) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [opened]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        event.key !== "/" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          (event.target.closest("input, textarea, select") ||
            event.target.isContentEditable))
      )
        return;
      event.preventDefault();
      if (window.matchMedia("(min-width: 600px)").matches)
        desktop.current?.querySelector("input")?.focus();
      else show();
    }
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  return (
    <>
      <div ref={desktop} className={styles.headerSearch}>
        <SearchBox
          action={action}
          query={query}
          tag={filters.tag}
          purpose={purpose}
          open={pathname === "/questions" || filters.open}
        />
      </div>
      <button
        className={styles.searchTrigger}
        type="button"
        aria-label="검색"
        aria-haspopup="dialog"
        onClick={show}
      >
        <Search size={20} aria-hidden="true" />
      </button>
      <dialog
        ref={dialog}
        className={styles.searchDialog}
        aria-label="글 검색"
        onClose={() => setOpened(false)}
        onCancel={close}
      >
        {opened && (
          <>
            <div className={styles.sheetHead}>
              <SearchBox
                action={action}
                query={query}
                tag={filters.tag}
                purpose={purpose}
                open={pathname === "/questions" || filters.open}
                autoFocus
                onSearch={close}
              />
              <button type="button" aria-label="검색 닫기" onClick={close}>
                <X size={20} aria-hidden="true" />
              </button>
            </div>
            <div className={styles.sheetBody}>
              <h2>최근 검색</h2>
              {recent.length ? (
                <div className={styles.topicCloud}>
                  {recent.map((value) => (
                    <Link
                      key={value}
                      href={`/?q=${encodeURIComponent(value)}`}
                      onClick={() => {
                        rememberSearch(value);
                        close();
                      }}
                    >
                      {value}
                    </Link>
                  ))}
                </div>
              ) : (
                <p>최근 검색이 없어요.</p>
              )}
              <h2>자주 찾는 주제</h2>
              <div className={styles.topicCloud}>
                {topics.map((topic) => (
                  <Link
                    key={topic.tag}
                    href={`/?tag=${encodeURIComponent(topic.tag)}`}
                    onClick={close}
                  >
                    #{canonicalTopic(topic.tag)}
                  </Link>
                ))}
              </div>
              <Link
                className={styles.sheetQuestions}
                href="/questions"
                onClick={close}
              >
                답을 기다리는 질문{" "}
                {openCount !== undefined ? `${openCount}개 ` : ""}보기
              </Link>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
