import "server-only";
import { cache } from "react";
import { getViewer } from "./auth";
import {
  getPost,
  getEditablePost,
  ForumError,
  listComments,
  listMyPosts,
  listPostPage,
  listPublicTopics,
  listAllPublicTopics,
} from "./forum";
import {
  feedPurposes,
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
import { canonicalTopic } from "@/lib/topic-aliases";
import type { Author, PostStatus, PostSummary, PostDetail } from "@/lib/types";
import type {
  AuthScreenData,
  EditPostScreenData,
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
    ...(post.author.role === "editor" && typeof post.recordPeriod === "string"
      ? { recordPeriod: post.recordPeriod }
      : {}),
    ...(post.author.role === "editor" &&
    Number.isSafeInteger(post.sourceCount) &&
    post.sourceCount! >= 0
      ? { sourceCount: post.sourceCount }
      : {}),
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

export function loadSiteNavigation() {
  return {
    topics: listPublicTopics(14),
    openCount: listPostPage({ open: true, pageSize: 1 }).total,
  };
}

export function loadFeedScreen(
  params: SearchParams,
  options: {
    title?: string;
    basePath?: "/" | "/questions";
    open?: boolean;
  } = {},
): FeedScreenData {
  const filters = {
    ...readFeedFilters(params),
    ...(options.open ? { open: true } : {}),
  };
  const basePath = options.basePath ?? "/";
  let result = listPostPage(filters);
  let compactEditorial: FeedScreenData["compactEditorial"];
  if (
    !filters.purpose &&
    !filters.tag &&
    !filters.query &&
    !filters.open &&
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
  const from = listHref(basePath, { ...filters, page: result.page });
  const writeParams = new URLSearchParams({ from });
  if (filters.purpose) writeParams.set("purpose", filters.purpose);
  if (filters.tag) writeParams.set("tag", filters.tag);
  return {
    basePath,
    ...(options.title ? { title: options.title } : {}),
    ...feedDiscovery(filters),
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

function feedDiscovery(filters: FeedScreenData["filters"]) {
  const open = listPostPage({ open: true, pageSize: 5 });
  const matchingTopic = filters.query
    ? listAllPublicTopics().find(
        (topic) =>
          canonicalTopic(topic.tag).toLowerCase() ===
          canonicalTopic(filters.query!).toLowerCase(),
      )
    : undefined;
  const questionCounts = new Map<string, number>();
  if (filters.open) {
    for (const post of listResourcePosts({ open: "1", purpose: "question" })) {
      for (const topic of new Set(post.tags.map(canonicalTopic)))
        questionCounts.set(topic, (questionCounts.get(topic) ?? 0) + 1);
    }
  }
  return {
    ...(matchingTopic ? { matchingTopic } : {}),
    ...(filters.open
      ? {
          questionTopics: [...questionCounts]
            .map(([tag, count]) => ({ tag, count }))
            .sort(
              (a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "ko"),
            )
            .slice(0, 8),
        }
      : {}),
    openCount: open.total,
    openPreview: open.posts.map(summary),
    topTopics: listPublicTopics(14),
    purposeCounts: Object.fromEntries(
      feedPurposes.map((purpose) => [
        purpose,
        listPostPage({ ...filters, purpose, page: 1, pageSize: 1 }).total,
      ]),
    ) as FeedScreenData["purposeCounts"],
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
    filters.purpose || filters.tag || filters.query || filters.open
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
    topics: listAllPublicTopics(),
    guides: guides.map((guide) => ({
      ...guide,
      posts: guide.posts.slice(0, 3),
    })),
    selected: selected ? { ...selected, posts: [] } : undefined,
    feed: {
      ...feedDiscovery(filters),
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
        ...new Set(
          (selected?.posts ?? allPosts).flatMap((post) =>
            post.tags.map(canonicalTopic),
          ),
        ),
      ]
        .slice(0, 12)
        .map((tag) => ({
          tag,
          count: (selected?.posts ?? allPosts).filter((post) =>
            post.tags.some((value) => canonicalTopic(value) === tag),
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
  const sameTopicPosts = published
    ? sameTopic(
        post,
        listResourcePosts(),
        new Set(relatedPosts.map((item) => item.id)),
      )
    : [];
  let editHref: string | undefined;
  if (viewer?.id === post.author.id) {
    try {
      getEditablePost(await getViewer(), id);
      editHref = `/posts/${encodeURIComponent(id)}/edit?from=${encodeURIComponent(returnTo)}`;
    } catch (error) {
      if (!(
        error instanceof ForumError && [401, 403, 404].includes(error.status)
      ))
        throw error;
    }
  }
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
    ...(editHref ? { editHref } : {}),
    relatedPosts,
    sameTopicPosts,
    publicationNotice: published ? null : publicationNotice(id, viewer?.id),
  };
}

function sameTopic(
  post: PostSummary,
  posts: PostSummary[],
  excluded: Set<string>,
): PostSummary[] {
  const mine = new Set(
    post.tags.map((tag) => canonicalTopic(tag).toLowerCase()),
  );
  const counts = new Map<string, number>();
  const topics = (item: PostSummary) =>
    new Set(item.tags.map((tag) => canonicalTopic(tag).toLowerCase()));
  for (const item of posts) {
    for (const tag of topics(item)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return posts
    .filter((item) => item.id !== post.id && !excluded.has(item.id))
    .map((item) => ({
      item,
      score: [...topics(item)].reduce(
        (score, tag) =>
          score + (mine.has(tag) ? 1 / Math.log2(1 + counts.get(tag)!) : 0),
        0,
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.item.createdAt.localeCompare(a.item.createdAt) ||
        a.item.id.localeCompare(b.item.id),
    )
    .slice(0, 3)
    .map(({ item }) => summary(item));
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
  const initialTitle =
    typeof params.title === "string" ? params.title.slice(0, 160) : undefined;
  if (initialTitle) writeParams.set("title", initialTitle);
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
      ...(initialTitle !== undefined ? { initialTitle } : {}),
      from,
    },
  };
}

export async function loadEditPostScreen(
  id: string,
  params: SearchParams,
): Promise<PageResult<EditPostScreenData> | null> {
  const from = safeListReturn(
    typeof params.from === "string" ? params.from : undefined,
  );
  const destination = `/posts/${encodeURIComponent(id)}/edit?from=${encodeURIComponent(from)}`;
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
  try {
    const { post, expectedHash } = getEditablePost(viewer, id);
    return {
      kind: "ready",
      data: {
        viewerId: viewer.id,
        from,
        editing: {
          id: post.id,
          title: post.title,
          body: post.body,
          kind: post.kind,
          tags: post.tags,
          expectedHash,
        },
      },
    };
  } catch (error) {
    if (error instanceof ForumError && [403, 404].includes(error.status))
      return null;
    throw error;
  }
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
