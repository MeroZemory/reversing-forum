import Link from "next/link";
import { ThemeSelector } from "@/components/theme-selector";
export function SiteFooter() {
  return (
    <footer className="shell site-footer">
      <nav aria-label="사이트 안내">
        <Link href="/guide">운영 안내</Link>
        <span aria-hidden="true"> · </span>
        <Link href="/report">삭제·이의 요청</Link>
      </nav>
      <ThemeSelector />
    </footer>
  );
}
