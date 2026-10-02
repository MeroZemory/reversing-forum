import { Info } from "lucide-react";
import type { ReactNode } from "react";

export function Notice({
  title,
  children,
  tone = "neutral",
}: {
  title: string;
  children: ReactNode;
  tone?: "neutral" | "warning";
}) {
  return (
    <div className={`notice notice-${tone}`}>
      <Info size={18} aria-hidden="true" />
      <div>
        <strong className="notice-title">{title}</strong>
        <div className="notice-body">{children}</div>
      </div>
    </div>
  );
}
