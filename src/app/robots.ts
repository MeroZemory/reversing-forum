import type { MetadataRoute } from "next";
import { siteUrl } from "@/server/site-config";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/new", "/me", "/login", "/register"],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
