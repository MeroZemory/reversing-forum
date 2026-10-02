import Link from "next/link";
import type { ReactNode } from "react";
import { AuthLinks } from "./auth-links";
import { BrandLogo } from "./brand-logo";
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
              {logoutControl}
            </>
          ) : (
            <AuthLinks />
          )}
        </nav>
      </div>
    </header>
  );
}
