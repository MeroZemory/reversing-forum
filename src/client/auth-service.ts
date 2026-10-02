import { authClient } from "@/lib/auth-client";
import type { AuthCommand, AuthMode } from "@/lib/interaction-types";
export async function authenticate(
  mode: AuthMode,
  command: AuthCommand,
): Promise<boolean> {
  const credentials = { email: command.email, password: command.password };
  const result =
    mode === "register"
      ? await authClient.signUp.email({
          ...credentials,
          name: command.name || "",
        })
      : await authClient.signIn.email(credentials);
  return !result.error;
}
export async function signOut(): Promise<boolean> {
  return !(await authClient.signOut()).error;
}
