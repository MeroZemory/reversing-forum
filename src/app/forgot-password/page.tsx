import type { Metadata } from "next";
import { AccountFlow } from "@/features/account-flow";
export const metadata: Metadata = { robots: { index: false, follow: false } };
export default function ForgotPasswordPage() {
  return <AccountFlow mode="forgot" />;
}
