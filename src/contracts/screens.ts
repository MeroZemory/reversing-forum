import type { FeedFilters } from "@/lib/feed-navigation";
import type {
  Author,
  Comment,
  PostDetail,
  PostStatus,
  PostSummary,
} from "@/lib/types";

export type SearchParams = Record<string, string | string[] | undefined>;
export type PageResult<T> =
  { kind: "ready"; data: T } | { kind: "redirect"; href: string };

export type FeedScreenData = {
  filters: FeedFilters;
  result: {
    posts: PostSummary[];
    total: number;
    page: number;
    pageSize: number;
    pageCount: number;
  };
  topics: { tag: string; count: number }[];
  from: string;
  writeHref: string;
};

export type PostDocument = {
  viewer: Author | null;
  post: PostDetail | null;
};
export type PostScreenData = {
  // Explicit future content language; current screens default to Korean.
  locale?: string;
  post: PostDetail;
  comments: Comment[];
  viewer: Author | null;
  returnTo: string;
  fromMyPosts: boolean;
  postPath: string;
  publicUrl: string;
};

export type MyPostsScreenData = {
  posts: (PostSummary & { status: PostStatus })[];
  total: number;
  counts: Record<PostStatus, number>;
  status?: PostStatus;
  returnPath: string;
  writeHref: string;
};

export type NewPostScreenData = {
  viewerId: string;
  initialPurpose?: FeedFilters["purpose"];
  initialTag?: string;
  from: string;
};
export type AuthScreenData = {
  mode: "login" | "register";
  returnTo: string;
};
