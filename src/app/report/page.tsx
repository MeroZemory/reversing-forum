import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { SearchParams } from "@/contracts/screens";
import { ReportScreen } from "@/components/screens/report-screen";
import { ReportForm } from "@/features/report-form";
import { getViewer } from "@/server/auth";
import { publicReportTarget } from "@/server/reports";
export const metadata: Metadata = {
  title: "신고·삭제 요청",
  robots: { index: false, follow: false },
};
export default async function Report({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  if (
    query.post !== undefined &&
    (typeof query.post !== "string" || !query.post || query.post.length > 128)
  )
    notFound();
  const target =
    typeof query.post === "string" ? publicReportTarget(query.post) : undefined;
  if (query.post && !target) notFound();
  const user = await getViewer(),
    path = target ? `/report?post=${encodeURIComponent(target.id)}` : "/report";
  return (
    <ReportScreen
      target={target}
      loginHref={`/login?returnTo=${encodeURIComponent(path)}`}
      form={user ? <ReportForm postId={target?.id} /> : null}
    />
  );
}
