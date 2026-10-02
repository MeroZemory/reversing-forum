import Link from "next/link";
import { AccountButton } from "./account-button";
import { AuthLinks } from "./auth-links";
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
            <AuthLinks />
          )}
        </nav>
      </div>
    </header>
  );
}
