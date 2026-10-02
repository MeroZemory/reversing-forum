import type { NextConfig } from "next";

const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
  devIndicators: false,
  outputFileTracingExcludes: {
    "*": ["./KakaoTalk*.txt", "./legacy/**/*", "./data/**/*", ".env", ".env.*"],
  },
};

export default config;
