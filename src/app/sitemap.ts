import type { MetadataRoute } from "next";
import { listPostPage } from "@/server/forum";
import { siteUrl } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const posts = listPostPage({ pageSize: 100 });
  const pages = [
    posts,
    ...Array.from({ length: posts.pageCount - 1 }, (_, index) =>
      listPostPage({ page: index + 2, pageSize: 100 }),
    ),
  ];
  return [
    { url: base },
    ...pages
      .flatMap((page) => page.posts)
      .map((post) => ({
        url: `${base}/posts/${post.id}`,
        lastModified: new Date(post.createdAt),
      })),
  ];
}
