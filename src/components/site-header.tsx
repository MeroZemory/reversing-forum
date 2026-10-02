import Link from "next/link";
import type { ReactNode } from "react";
import { AuthLinks } from "./auth-links";
import { BrandLogo } from "./brand-logo";
import { AccountMenu } from "./account-menu";
import type { Author } from "@/lib/types";

export function SiteHeader({
  viewer,
  logoutControl,
}: {
  viewer: Author | null;
  logoutControl: ReactNode;
}) {
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
              <AccountMenu>
                <Link className="account-link" href="/account">
                  계정 설정
                </Link>
                {logoutControl}
              </AccountMenu>
            </>
          ) : (
            <AuthLinks />
          )}
        </nav>
      </div>
    </header>
  );
}
