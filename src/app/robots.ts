import type { MetadataRoute } from "next";
import { siteUrl } from "@/server/site-config";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/new",
        "/me",
        "/login",
        "/register",
        "/account",
        "/onboarding",
        "/verify-email",
        "/forgot-password",
        "/reset-password",
        "/report",
        "/moderation/",
      ],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
