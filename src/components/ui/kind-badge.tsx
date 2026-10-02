import { getPostPurpose, purposeLabels, type PostKind } from "@/lib/types";

export function KindBadge({ kind }: { kind: PostKind }) {
  const purpose = getPostPurpose(kind);
  return (
    <span className={`kind-badge kind-${purpose}`}>
      {purposeLabels[purpose]}
    </span>
  );
}
