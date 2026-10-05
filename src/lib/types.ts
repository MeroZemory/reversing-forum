export const postKinds = [
  "discussion",
  "question",
  "analysis",
  "workflow",
] as const;
export type PostKind = (typeof postKinds)[number];
export type PostPurpose = "question" | "share" | "discussion";

export const purposeLabels: Record<PostPurpose, string> = {
  question: "질문",
  share: "공유",
  discussion: "자유",
};

export const postKindToPurpose: Record<PostKind, PostPurpose> = {
  question: "question",
  analysis: "share",
  workflow: "share",
  discussion: "discussion",
};

export function getPostPurpose(kind: PostKind): PostPurpose {
  return postKindToPurpose[kind];
}

export type PostStatus = "pending" | "published" | "held";

export type Author = { id: string; name: string; role?: "editor" };
export type EditorialProvenance = {
  sourceType: "chat-editorial" | "independent-guide";
  period: string;
  verificationSummary: string;
};
export type Viewer = Author & {
  email: string;
  emailVerified?: boolean;
  nicknameReady?: boolean;
};
export type PostSummary = {
  id: string;
  title: string;
  excerpt: string;
  kind: PostKind;
  tags: string[];
  author: Author;
  createdAt: string;
  commentCount: number;
  recordPeriod?: string;
  sourceCount?: number;
};
export type PostDetail = PostSummary & {
  body: string;
  status: PostStatus;
  editorial?: EditorialProvenance;
};
export type Comment = {
  id: string;
  postId: string;
  parentId: string | null;
  author: Author;
  body: string;
  createdAt: string;
};

export const kindLabels: Record<PostKind, string> = {
  discussion: "자유",
  question: "질문",
  analysis: "분석",
  workflow: "AI 활용",
};
