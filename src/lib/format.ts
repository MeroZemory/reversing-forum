export function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

export function safeReturnPath(value: unknown) {
  if (
    typeof value !== "string" ||
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return "/";
  }
  return value;
}

export function safeAuthReturn(value: unknown) {
  const path = safeReturnPath(value);
  return /^\/(login|register)(\/|$)/.test(
    new URL(path, "https://reversing-all.invalid").pathname,
  )
    ? "/"
    : path;
}
