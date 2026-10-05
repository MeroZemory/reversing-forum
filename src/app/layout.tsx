import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { loadSiteNavigation, loadViewer } from "@/server/screens";
import { AccountButton } from "@/features/account-button";
import { siteUrl } from "@/server/site-config";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: "Reversing All",
    template: "%s | Reversing All",
  },
  description:
    "리버스 엔지니어링의 질문, 분석 과정과 AI 활용법을 함께 나누는 커뮤니티입니다.",
  openGraph: { type: "website", locale: "ko_KR", siteName: "Reversing All" },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const viewer = await loadViewer();
  const navigation = loadSiteNavigation();
  return (
    // The theme script and browser companions can change root attributes before
    // hydration. Scope the exception to <html>; page content stays checked.
    <html
      lang="ko"
      data-theme="system"
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <head>
        <script src="/theme-bootstrap.js" async blocking="render" />
      </head>
      <body>
        <a className="skip-link" href="#main">
          본문으로 바로가기
        </a>
        <SiteHeader
          {...navigation}
          viewer={viewer}
          logoutControl={viewer ? <AccountButton /> : null}
        />
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
