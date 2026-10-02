import "server-only";

export function siteUrl() {
  return (
    process.env.SITE_URL ||
    process.env.BETTER_AUTH_URL ||
    "http://127.0.0.1:3000"
  );
}
