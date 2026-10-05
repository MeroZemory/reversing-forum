import type { FeedFilters } from "./feed-navigation";

export const resourceSlugs = [
  "learning",
  "executables",
  "systems",
  "devices",
] as const;

export function isResourcePath(path: string) {
  return (
    path === "/questions" ||
    path === "/resources" ||
    resourceSlugs.some((slug) => path === `/resources/${slug}`)
  );
}

// Pure URL construction shared by server projection and rendering components.
export function listHref(
  basePath: string,
  { purpose, tag, query, page, open }: FeedFilters = {},
) {
  const params = new URLSearchParams();
  if (purpose) params.set("purpose", purpose);
  if (tag) params.set("tag", tag);
  if (query) params.set("q", query);
  if (page && page > 1) params.set("page", String(page));
  if (open) params.set("open", "1");
  return basePath + (params.size ? `?${params}` : "");
}
