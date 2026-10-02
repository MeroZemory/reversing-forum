import {
  getPostPurpose,
  postKinds,
  type PostKind,
  type PostPurpose,
} from "./types";
import { isResourcePath, listHref } from "./resource-navigation";

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

export function feedHref(filters: FeedFilters = {}) {
  return listHref("/", filters);
}

export function safeFeedReturn(value?: string) {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return "/";
  try {
    const url = new URL(value, "https://reversing-all.invalid");
    if (
      url.origin !== "https://reversing-all.invalid" ||
      (url.pathname !== "/" && !isResourcePath(url.pathname))
    )
      return "/";
    return listHref(
      url.pathname,
      readFeedFilters(Object.fromEntries(url.searchParams)),
    );
  } catch {
    return "/";
  }
}

export function safeListReturn(value?: string) {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
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
