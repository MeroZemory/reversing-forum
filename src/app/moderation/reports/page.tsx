import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OperatorReportsScreen } from "@/components/screens/operator-reports-screen";
import { canReviewReports, loadOperatorReports } from "@/server/reports";
export const metadata: Metadata = {
  title: "신고·이의 접수 목록",
  robots: { index: false, follow: false },
};
export default async function OperatorReports() {
  if (!(await canReviewReports())) notFound();
  return <OperatorReportsScreen reports={await loadOperatorReports()} />;
}
