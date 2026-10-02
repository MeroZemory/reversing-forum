"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { safeAuthReturn } from "@/lib/format";

export function AuthLinks() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentRoute = pathname.replace(/\/$/, "") || "/";
  const authRoute = currentRoute === "/login" || currentRoute === "/register";
  const returnValues = searchParams.getAll("returnTo");
  const query = searchParams.toString();
  const destination = safeAuthReturn(
    authRoute
      ? returnValues.length === 1
        ? returnValues[0]
        : undefined
      : `${pathname}${query ? `?${query}` : ""}`,
  );
  const suffix =
    destination === "/" ? "" : `?returnTo=${encodeURIComponent(destination)}`;

  if (authRoute) {
    return (
      <Link className="account-link" href="/">
        글 둘러보기
      </Link>
    );
  }

  return (
    <>
      <Link
        className="account-link"
        href={`/login${suffix}`}
        aria-current={currentRoute === "/login" ? "page" : undefined}
      >
        로그인
      </Link>
      <Link
        className="account-link"
        href={`/register${suffix}`}
        aria-current={currentRoute === "/register" ? "page" : undefined}
      >
        회원가입
      </Link>
    </>
  );
}
