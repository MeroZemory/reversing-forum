"use client";
import { useSignOut } from "@/client/hooks/use-sign-out";
import { AccountButtonView } from "@/components/account-button";
export function AccountButton() {
  return <AccountButtonView state={useSignOut()} />;
}
