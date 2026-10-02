"use client";

import Link from "next/link";
import { useLayoutEffect, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

const scrollKey = (href: string) => `reversing-all:feed-scroll:${href}`;
const restoreKey = "reversing-all:feed-return";

export function PostLink({
  id,
  title,
  from,
  children,
  className,
}: {
  id: string;
  title: string;
  from: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={`/posts/${id}?from=${encodeURIComponent(from)}`}
      className={className}
      onNavigate={() => {
        try {
          sessionStorage.setItem(scrollKey(from), String(window.scrollY));
        } catch {}
      }}
    >
      {children || title}
    </Link>
  );
}

export function FeedScrollRestoration({ href }: { href: string }) {
  useLayoutEffect(() => {
    try {
      if (sessionStorage.getItem(restoreKey) !== href) return;
      sessionStorage.removeItem(restoreKey);
      const saved = sessionStorage.getItem(scrollKey(href));
      if (saved === null) return;
      const y = Number(saved);
      if (Number.isFinite(y) && y >= 0)
        window.scrollTo({ top: y, behavior: "instant" });
    } catch {}
  }, [href]);
  return null;
}

export function ListReturnLink({
  href,
  privatePost = false,
}: {
  href: string;
  privatePost?: boolean;
}) {
  return (
    <Link
      className="back-link"
      href={href}
      scroll={false}
      onNavigate={() => {
        try {
          sessionStorage.setItem(restoreKey, href);
        } catch {}
      }}
    >
      <ArrowLeft size={16} aria-hidden="true" />
      {privatePost ? "내 글로 돌아가기" : "목록으로 돌아가기"}
    </Link>
  );
}
