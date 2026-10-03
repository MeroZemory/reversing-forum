import Link from "next/link";
import { reportReasons, type OperatorReport } from "@/contracts/reports";
import { formatDate } from "@/lib/format";
export function OperatorReportsScreen({
  reports,
}: {
  reports: OperatorReport[];
}) {
  return (
    <div className="shell article-shell">
      <h1>신고·이의 접수 목록</h1>
      <p className="page-intro">
        최신 접수 100건까지 표시합니다. 요청 내용을 확인한 뒤 해당 글의
        수정·비공개 처리를 검토하세요.
      </p>
      {reports.length === 0 ? (
        <p>접수된 요청이 없습니다.</p>
      ) : (
        <ol className="operator-reports">
          {reports.map((report) => (
            <li key={report.id}>
              <h2>{reportReasons[report.reason]}</h2>
              <p>
                {report.postId && report.postTitle ? (
                  <Link href={`/posts/${encodeURIComponent(report.postId)}`}>
                    {report.postTitle || "대상 글"}
                  </Link>
                ) : report.postId ? (
                  "현재 공개되지 않은 글에 관한 요청"
                ) : (
                  "특정 글을 지정하지 않은 요청"
                )}{" "}
                ·{" "}
                <time dateTime={report.createdAt}>
                  {formatDate(report.createdAt)}
                </time>
              </p>
              <p className="report-detail">{report.detail}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
