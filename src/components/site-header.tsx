import Link from "next/link";
import { AccountButton } from "./account-button";
import { BrandLogo } from "./brand-logo";
import type { Viewer } from "@/lib/types";

export function SiteHeader({ viewer }: { viewer: Viewer | null }) {
  return (
    <header className="site-header">
      <div className="shell header-inner">
        <BrandLogo />
        <nav className="header-actions" aria-label="계정">
          {viewer ? (
            <>
              <Link className="account-link member-link" href="/me">
                내 글
              </Link>
              <AccountButton />
            </>
          ) : (
            <>
              <Link className="account-link" href="/login">
                로그인
              </Link>
              <Link className="account-link" href="/register">
                회원가입
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
