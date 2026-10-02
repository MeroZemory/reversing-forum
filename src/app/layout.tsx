import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { getViewer } from "@/server/auth";
import { siteUrl } from "@/lib/format";
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
  const viewer = await getViewer();
  return (
    // Browser companions can add attributes to this document element before
    // hydration. Scope the exception to <html>; page content stays checked.
    <html lang="ko" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body>
        <a className="skip-link" href="#main">
          본문으로 바로가기
        </a>
        <SiteHeader viewer={viewer} />
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </body>
    </html>
  );
}
