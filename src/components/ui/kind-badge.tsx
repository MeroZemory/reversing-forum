import { kindLabels, type PostKind } from "@/lib/types";

export function KindBadge({ kind }: { kind: PostKind }) {
  return <span className={`kind-badge kind-${kind}`}>{kindLabels[kind]}</span>;
}
