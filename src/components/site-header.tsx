import type { ReactNode } from "react";
import { AuthLinks } from "./auth-links";
import { BrandLogo } from "./brand-logo";
import { SiteEntrances, SubNav } from "./resources-ui";
import {
  HeaderAccountLinks,
  HeaderSearch,
  HeaderWriteLink,
} from "./header-search";
import type { Author } from "@/lib/types";
import styles from "./community-layout.module.css";

export function SiteHeader({
  viewer,
  logoutControl,
  topics = [],
  openCount,
}: {
  viewer: Author | null;
  logoutControl: ReactNode;
  topics?: { tag: string; count: number }[];
  openCount?: number;
}) {
  return (
    <>
      <header className={`site-header ${styles.header}`}>
        <div className={`shell ${styles.headerInner}`}>
          <BrandLogo />
          <SiteEntrances desktop />
          <HeaderSearch topics={topics} openCount={openCount} />
          <HeaderWriteLink />
          <nav className={`header-actions ${styles.account}`} aria-label="계정">
            {viewer ? (
              <HeaderAccountLinks logoutControl={logoutControl} />
            ) : (
              <AuthLinks />
            )}
          </nav>
        </div>
      </header>
      <SubNav openCount={openCount} />
    </>
  );
}
