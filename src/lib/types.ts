export const postKinds = [
  "discussion",
  "question",
  "analysis",
  "workflow",
] as const;
export type PostKind = (typeof postKinds)[number];
export type PostStatus = "pending" | "published" | "held";

export type Author = { id: string; name: string };
export type Viewer = Author & { email: string };
export type PostSummary = {
  id: string;
  title: string;
  excerpt: string;
  kind: PostKind;
  tags: string[];
  author: Author;
  createdAt: string;
  commentCount: number;
};
export type PostDetail = PostSummary & { body: string; status: PostStatus };
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
