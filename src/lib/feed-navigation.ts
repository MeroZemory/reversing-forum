import {
  getPostPurpose,
  postKinds,
  type PostKind,
  type PostPurpose,
} from "./types";

export type FeedFilters = {
  purpose?: PostPurpose;
  tag?: string;
  query?: string;
  page?: number;
};
export const feedPurposes: PostPurpose[] = ["question", "share", "discussion"];

export function readFeedFilters(
  params: Record<string, string | string[] | undefined>,
): FeedFilters {
  const value = (key: string) =>
    typeof params[key] === "string" ? (params[key] as string) : "";
  const requestedPurpose = value("purpose") as PostPurpose;
  const legacyKind = value("kind") as PostKind;
  const purpose = feedPurposes.includes(requestedPurpose)
    ? requestedPurpose
    : postKinds.includes(legacyKind)
      ? getPostPurpose(legacyKind)
      : undefined;
  const page = Number(value("page"));
  return {
    purpose,
    tag: value("tag").trim().slice(0, 24) || undefined,
    query: value("q").trim().slice(0, 200) || undefined,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

export function feedHref({ purpose, tag, query, page }: FeedFilters = {}) {
  const params = new URLSearchParams();
  if (purpose) params.set("purpose", purpose);
  if (tag) params.set("tag", tag);
  if (query) params.set("q", query);
  if (page && page > 1) params.set("page", String(page));
  return params.size ? `/?${params}` : "/";
}

export function safeFeedReturn(value?: string) {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  )
    return "/";
  try {
    const url = new URL(value, "https://reversing-all.invalid");
    if (url.origin !== "https://reversing-all.invalid" || url.pathname !== "/")
      return "/";
    return feedHref(readFeedFilters(Object.fromEntries(url.searchParams)));
  } catch {
    return "/";
  }
}

export function safeListReturn(value?: string) {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  )
    return "/";
  try {
    const url = new URL(value, "https://reversing-all.invalid");
    if (url.origin !== "https://reversing-all.invalid") return "/";
    if (url.pathname !== "/me") return safeFeedReturn(value);
    const statuses = url.searchParams.getAll("status");
    const status =
      statuses.length === 1 &&
      ["published", "pending", "held"].includes(statuses[0])
        ? statuses[0]
        : undefined;
    return status ? `/me?status=${status}` : "/me";
  } catch {
    return "/";
  }
}
