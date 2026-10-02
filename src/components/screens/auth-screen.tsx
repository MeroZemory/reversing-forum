import type { ReactNode } from "react";
export function AuthScreen({ form }: { form: ReactNode }) {
  return <div className="shell auth-shell">{form}</div>;
}
