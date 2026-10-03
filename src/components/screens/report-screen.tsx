import Link from "next/link";
import type { ReactNode } from "react";
import { ActionLink } from "../ui/action";
export function ReportScreen({
  target,
  form,
  loginHref,
}: {
  target?: { id: string; title: string };
  form: ReactNode;
  loginHref: string;
}) {
  return (
    <div className="shell editor-shell">
      <h1>{target ? "글 신고·삭제 요청" : "삭제·이의 요청"}</h1>
      {target && (
        <p className="page-intro">
          대상 글:{" "}
          <Link href={`/posts/${encodeURIComponent(target.id)}`}>
            {target.title}
          </Link>
        </p>
      )}
      <p>
        개인정보·권리 침해, 내용 오류나 스팸을 운영자에게 알려 주세요. 접수한
        내용은 공개되지 않습니다.
      </p>
      {form || (
        <>
          <p>로그인 후 요청을 보낼 수 있습니다.</p>
          <ActionLink href={loginHref}>로그인하고 요청하기</ActionLink>
        </>
      )}
    </div>
  );
}
