import type { FeedFilters } from "@/lib/feed-navigation";
import type { PostFormProps } from "@/lib/interaction-types";
import type {
  Author,
  Comment,
  PostDetail,
  PostStatus,
  PostSummary,
  PostPurpose,
} from "@/lib/types";

export type SearchParams = Record<string, string | string[] | undefined>;
export type PageResult<T> =
  { kind: "ready"; data: T } | { kind: "redirect"; href: string };

export type FeedScreenData = {
  basePath?: string;
  title?: string;
  intro?: string;
  compactEditorial?: {
    posts: PostSummary[];
    total: number;
    activityTotal: number;
  };
  filters: FeedFilters;
  result: {
    posts: PostSummary[];
    total: number;
    page: number;
    pageSize: number;
    pageCount: number;
  };
  topics: { tag: string; count: number }[];
  openCount: number;
  openPreview: PostSummary[];
  topTopics: { tag: string; count: number }[];
  purposeCounts: Record<PostPurpose, number>;
  matchingTopic?: { tag: string; count: number };
  questionTopics?: { tag: string; count: number }[];
  from: string;
  writeHref: string;
};

export type ResourceGuide = {
  slug: string;
  title: string;
  description: string;
  count: number;
  posts: PostSummary[];
};
export type ResourcesScreenData = {
  topics: { tag: string; count: number }[];
  guides: ResourceGuide[];
  selected?: ResourceGuide;
  feed: FeedScreenData;
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
  editHref?: string;
  relatedPosts?: { id: string; title: string }[];
  sameTopicPosts?: PostSummary[];
  publicationNotice?: {
    reason:
      | "duplicate"
      | "waiting"
      | "screening"
      | "size"
      | "budget"
      | "busy"
      | "attempt-limit";
    relatedPosts: { id: string; title: string }[];
    canRetry: boolean;
    canRequestReview?: boolean;
  } | null;
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
  initialTitle?: string;
  from: string;
};
export type EditPostScreenData = PostFormProps & {
  editing: NonNullable<PostFormProps["editing"]>;
};
export type AuthScreenData = {
  mode: "login" | "register";
  returnTo: string;
};
