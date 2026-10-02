import "server-only";
import { cache } from "react";
import { getViewer } from "./auth";
import {
  getPost,
  listComments,
  listMyPosts,
  listPostPage,
  listPublicTopics,
} from "./forum";
import {
  feedHref,
  readFeedFilters,
  safeFeedReturn,
  safeListReturn,
} from "@/lib/feed-navigation";
import { safeAuthReturn } from "@/lib/format";
import { siteUrl } from "./site-config";
import type { Author, PostStatus } from "@/lib/types";
import type {
  AuthScreenData,
  FeedScreenData,
  MyPostsScreenData,
  NewPostScreenData,
  PageResult,
  PostDocument,
  PostScreenData,
  SearchParams,
} from "@/contracts/screens";

// Screen data is serializable and explicitly projected. Session credentials,
// email addresses, database rows and screening evidence never enter a view.
export async function loadViewer(): Promise<Author | null> {
  const viewer = await getViewer();
  return viewer ? { id: viewer.id, name: viewer.name } : null;
}

export function loadFeedScreen(params: SearchParams): FeedScreenData {
  const filters = readFeedFilters(params);
  const result = listPostPage(filters);
  const from = feedHref({ ...filters, page: result.page });
  const writeParams = new URLSearchParams({ from });
  if (filters.purpose) writeParams.set("purpose", filters.purpose);
  if (filters.tag) writeParams.set("tag", filters.tag);
  return {
    filters,
    result,
    topics: listPublicTopics(12),
    from,
    writeHref: `/new?${writeParams}`,
  };
}

// Metadata and page rendering share the same request-scoped authorization read.
export const loadPostDocument = cache(
  async (id: string): Promise<PostDocument> => {
    const viewer = await loadViewer();
    return { viewer, post: getPost(id, viewer?.id) };
  },
);

export async function loadPostScreen(
  id: string,
  params: SearchParams,
): Promise<PostScreenData | null> {
  const { viewer, post } = await loadPostDocument(id);
  if (!post) return null;
  const published = post.status === "published";
  const from = typeof params.from === "string" ? params.from : undefined;
  const fromMyPosts =
    viewer?.id === post.author.id && !!from && /^\/me(?:\?|$)/.test(from);
  const ownReturn = safeListReturn(from);
  const returnTo =
    !published || fromMyPosts
      ? ownReturn.startsWith("/me")
        ? ownReturn
        : "/me"
      : safeFeedReturn(from);
  const postPath = `/posts/${id}${from ? `?from=${encodeURIComponent(fromMyPosts ? returnTo : safeFeedReturn(from))}` : ""}`;
  return {
    post,
    viewer,
    returnTo,
    fromMyPosts,
    postPath,
    comments: published ? listComments(id) : [],
    publicUrl: `${siteUrl()}/posts/${post.id}`,
  };
}

export async function loadMyPostsScreen(
  params: SearchParams,
): Promise<PageResult<MyPostsScreenData>> {
  const statuses: PostStatus[] = ["published", "pending", "held"];
  const status = statuses.find((value) => value === params.status);
  const returnPath = status ? `/me?status=${status}` : "/me";
  const viewer = await loadViewer();
  if (!viewer)
    return {
      kind: "redirect",
      href: `/login?returnTo=${encodeURIComponent(returnPath)}`,
    };
  const allPosts = listMyPosts(viewer.id);
  const counts = { published: 0, pending: 0, held: 0 };
  for (const post of allPosts) counts[post.status] += 1;
  const visible = status
    ? allPosts.filter((post) => post.status === status)
    : allPosts;
  const posts = visible.map(({ body: _body, ...post }) => post);
  return {
    kind: "ready",
    data: {
      posts,
      total: allPosts.length,
      counts,
      status,
      returnPath,
      writeHref: `/new?from=${encodeURIComponent(returnPath)}`,
    },
  };
}

export async function loadNewPostScreen(
  params: SearchParams,
): Promise<PageResult<NewPostScreenData>> {
  const filters = readFeedFilters(params);
  const from = safeListReturn(
    typeof params.from === "string" ? params.from : undefined,
  );
  const writeParams = new URLSearchParams();
  if (filters.purpose) writeParams.set("purpose", filters.purpose);
  if (filters.tag) writeParams.set("tag", filters.tag);
  if (params.from) writeParams.set("from", from);
  const destination = `/new${writeParams.size ? `?${writeParams}` : ""}`;
  const viewer = await loadViewer();
  if (!viewer)
    return {
      kind: "redirect",
      href: `/login?returnTo=${encodeURIComponent(destination)}`,
    };
  return {
    kind: "ready",
    data: {
      viewerId: viewer.id,
      initialPurpose: filters.purpose,
      initialTag: filters.tag,
      from,
    },
  };
}

export async function loadAuthScreen(
  mode: AuthScreenData["mode"],
  params: SearchParams,
): Promise<PageResult<AuthScreenData>> {
  const returnTo = safeAuthReturn(params.returnTo);
  if (await loadViewer()) return { kind: "redirect", href: returnTo };
  return { kind: "ready", data: { mode, returnTo } };
}
