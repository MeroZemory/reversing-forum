"use client";
import type { AuthFormProps } from "@/lib/interaction-types";
import { useAuthForm } from "@/client/hooks/use-auth-form";
import { AuthFormView } from "@/components/auth-form";
export function AuthForm(props: AuthFormProps) {
  return <AuthFormView mode={props.mode} state={useAuthForm(props)} />;
}
