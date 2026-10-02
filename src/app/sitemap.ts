import type { MetadataRoute } from "next";
import { listPosts } from "@/server/forum";
import { siteUrl } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  return [
    { url: base },
    ...listPosts({ limit: 1000 }).map((post) => ({
      url: `${base}/posts/${post.id}`,
      lastModified: new Date(post.createdAt),
    })),
  ];
}
