import type { Metadata } from "next";
import { NotFoundScreen } from "@/components/screens/not-found-screen";
export const metadata: Metadata = {
  title: "페이지를 찾을 수 없습니다",
  robots: { index: false, follow: false },
};
export default function NotFound() {
  return <NotFoundScreen />;
}
