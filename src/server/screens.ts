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
import { listHref } from "@/lib/resource-navigation";
import { siteUrl } from "./site-config";
import { relatedPublicPosts } from "./duplicates/index";
import { publicationNotice } from "./publication-notice";
import { listResourcePosts, resourceGuides } from "./resources";
import { currentResourceSelection } from "./resource-curation";
import type { Author, PostStatus, PostSummary, PostDetail } from "@/lib/types";
import type {
  AuthScreenData,
  FeedScreenData,
  MyPostsScreenData,
  NewPostScreenData,
  PageResult,
  PostDocument,
  PostScreenData,
  SearchParams,
  ResourcesScreenData,
} from "@/contracts/screens";

// Screen data is serializable and explicitly projected. Session credentials,
// email addresses, database rows and screening evidence never enter a view.
function summary(post: PostSummary): PostSummary {
  return {
    id: post.id,
    title: post.title,
    excerpt: post.excerpt,
    kind: post.kind,
    tags: post.tags,
    createdAt: post.createdAt,
    commentCount: post.commentCount,
    author: {
      id: post.author.id,
      name: post.author.name,
      ...(post.author.role === "editor" ? { role: "editor" as const } : {}),
    },
  };
}

function postDetail(post: PostDetail): PostDetail {
  return {
    ...summary(post),
    body: post.body,
    status: post.status,
    ...(post.status === "published" &&
    post.author.role === "editor" &&
    post.editorial
      ? {
          editorial: {
            sourceType: post.editorial.sourceType,
            period: post.editorial.period,
            verificationSummary: post.editorial.verificationSummary,
          },
        }
      : {}),
  };
}

export async function loadViewer(): Promise<Author | null> {
  const viewer = await getViewer();
  return viewer ? { id: viewer.id, name: viewer.name } : null;
}

export function loadFeedScreen(params: SearchParams): FeedScreenData {
  const filters = readFeedFilters(params);
  let result = listPostPage(filters);
  let compactEditorial: FeedScreenData["compactEditorial"];
  if (
    !filters.purpose &&
    !filters.tag &&
    !filters.query &&
    result.total >= 30
  ) {
    const publicPosts = listResourcePosts();
    const editors = publicPosts.filter((post) => post.author.role === "editor");
    if (editors.length >= 30) {
      const quiet = editors.filter((post) => post.commentCount === 0);
      const activity = publicPosts.filter(
        (post) => post.author.role !== "editor" || post.commentCount > 0,
      );
      // During initial seeding the articles themselves are the usable feed.
      // Compact them once there is actual conversation to prioritize.
      if (activity.length && quiet.length) {
        const pageCount = Math.max(
          1,
          Math.ceil(activity.length / result.pageSize),
        );
        const page = Math.min(filters.page ?? 1, pageCount);
        compactEditorial = {
          posts: quiet.slice(0, 3).map(summary),
          total: quiet.length,
          activityTotal: activity.length,
        };
        result = {
          ...result,
          posts: activity.slice(
            (page - 1) * result.pageSize,
            page * result.pageSize,
          ),
          page,
          pageCount,
        };
      }
    }
  }
  const from = feedHref({ ...filters, page: result.page });
  const writeParams = new URLSearchParams({ from });
  if (filters.purpose) writeParams.set("purpose", filters.purpose);
  if (filters.tag) writeParams.set("tag", filters.tag);
  return {
    ...(compactEditorial ? { compactEditorial } : {}),
    filters,
    result: {
      posts: result.posts.map(summary),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      pageCount: result.pageCount,
    },
    topics: listPublicTopics(12).map(({ tag, count }) => ({ tag, count })),
    from,
    writeHref: `/new?${writeParams}`,
  };
}

export function loadResourcesScreen(
  params: SearchParams,
  slug?: string,
): ResourcesScreenData | null {
  const allPosts = listResourcePosts().map(summary);
  const guides = resourceGuides(allPosts, currentResourceSelection());
  const selected = slug
    ? guides.find((guide) => guide.slug === slug)
    : undefined;
  if (slug && !selected) return null;
  const filters = readFeedFilters(params);
  const allowed = selected
    ? new Set(selected.posts.map((post) => post.id))
    : null;
  const matching =
    filters.purpose || filters.tag || filters.query
      ? listResourcePosts(params).map(summary)
      : allPosts;
  const posts = allowed
    ? matching.filter((post) => allowed.has(post.id))
    : matching;
  const pageSize = 30;
  const pageCount = Math.max(1, Math.ceil(posts.length / pageSize));
  const page = Math.min(filters.page ?? 1, pageCount);
  const basePath = slug ? `/resources/${slug}` : "/resources";
  const from = listHref(basePath, { ...filters, page });
  const writeParams = new URLSearchParams({ from });
  if (filters.purpose) writeParams.set("purpose", filters.purpose);
  if (filters.tag) writeParams.set("tag", filters.tag);
  return {
    guides: guides.map((guide) => ({
      ...guide,
      posts: guide.posts.slice(0, 3),
    })),
    selected: selected ? { ...selected, posts: [] } : undefined,
    feed: {
      basePath,
      filters,
      from,
      writeHref: `/new?${writeParams}`,
      title: selected?.title ?? "자료 검색",
      intro:
        selected?.description ??
        "길잡이에 연결되지 않은 글도 전체 공개 글에서 검색할 수 있습니다.",
      result: {
        posts: posts.slice((page - 1) * pageSize, page * pageSize),
        total: posts.length,
        page,
        pageSize,
        pageCount,
      },
      topics: [
        ...new Set((selected?.posts ?? allPosts).flatMap((post) => post.tags)),
      ]
        .slice(0, 12)
        .map((tag) => ({
          tag,
          count: (selected?.posts ?? allPosts).filter((post) =>
            post.tags.includes(tag),
          ).length,
        })),
    },
  };
}

// Metadata and page rendering share the same request-scoped authorization read.
export const loadPostDocument = cache(
  async (id: string): Promise<PostDocument> => {
    const viewer = await loadViewer();
    const post = getPost(id, viewer?.id);
    return { viewer, post: post ? postDetail(post) : null };
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
  const related = published ? await relatedPublicPosts(id) : null;
  const relatedPosts = (related?.relatedPostIds ?? []).flatMap((relatedId) => {
    // The related lookup and display both enforce current public visibility.
    const found = getPost(relatedId);
    return found?.status === "published" && found.id !== id
      ? [{ id: found.id, title: found.title }]
      : [];
  });
  return {
    post,
    viewer,
    returnTo,
    fromMyPosts,
    postPath,
    comments: published
      ? listComments(id).map((comment) => ({
          id: comment.id,
          postId: comment.postId,
          parentId: comment.parentId,
          body: comment.body,
          createdAt: comment.createdAt,
          author: { id: comment.author.id, name: comment.author.name },
        }))
      : [],
    publicUrl: `${siteUrl()}/posts/${post.id}`,
    relatedPosts,
    publicationNotice: published ? null : publicationNotice(id, viewer?.id),
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
  const posts = visible.map((post) => ({
    ...summary(post),
    status: post.status,
  }));
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
  const rawFrom = typeof params.from === "string" ? params.from : undefined;
  const from = safeListReturn(rawFrom);
  const writeParams = new URLSearchParams();
  if (filters.purpose) writeParams.set("purpose", filters.purpose);
  if (filters.tag) writeParams.set("tag", filters.tag);
  if (params.from) writeParams.set("from", from);
  const destination = `/new${writeParams.size ? `?${writeParams}` : ""}`;
  const viewer = await getViewer();
  if (!viewer)
    return {
      kind: "redirect",
      href: `/login?returnTo=${encodeURIComponent(destination)}`,
    };
  if (viewer.nicknameReady === false)
    return {
      kind: "redirect",
      href: `/onboarding?returnTo=${encodeURIComponent(destination)}`,
    };
  if (viewer.emailVerified === false)
    return {
      kind: "redirect",
      href: `/account?returnTo=${encodeURIComponent(destination)}`,
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
  const viewer = await getViewer();
  if (viewer && params.reauth !== "1")
    return {
      kind: "redirect",
      href:
        viewer.nicknameReady === false
          ? `/onboarding?returnTo=${encodeURIComponent(returnTo)}`
          : returnTo,
    };
  return { kind: "ready", data: { mode, returnTo } };
}
