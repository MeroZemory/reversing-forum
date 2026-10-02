export function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

export function safeReturnPath(value: string | null | undefined) {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/";
  }
  return value;
}

export function siteUrl() {
  return (
    process.env.SITE_URL ||
    process.env.BETTER_AUTH_URL ||
    "http://127.0.0.1:3000"
  );
}
