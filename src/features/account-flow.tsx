"use client";
import type { AccountFlowMode } from "@/lib/interaction-types";
import { useAccountFlow } from "@/client/hooks/use-account-flow";
import { AccountFlowView } from "@/components/account-flow";
export function AccountFlow(props: {
  mode: AccountFlowMode;
  token?: string;
  error?: string;
  verified?: boolean;
  returnTo?: string;
}) {
  return <AccountFlowView state={useAccountFlow(props)} />;
}
