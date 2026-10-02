import { ActionLink } from "@/components/ui/action";

export default function NotFound() {
  return (
    <div className="shell not-found">
      <span className="eyebrow muted">404</span>
      <h1>글을 찾을 수 없습니다.</h1>
      <p>주소를 확인하거나 커뮤니티에서 다른 이야기를 찾아보세요.</p>
      <ActionLink href="/">커뮤니티로 돌아가기</ActionLink>
    </div>
  );
}
