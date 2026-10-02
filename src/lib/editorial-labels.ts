import type { Author } from "./types";

const names: Record<string, string> = {
  ko: "자료편집",
  en: "Editorial",
  fr: "Rédaction",
  de: "Redaktion",
  es: "Edición",
};
const badges: Record<string, string> = {
  ko: "운영계정",
  en: "Staff",
  fr: "Équipe",
  de: "Team",
  es: "Equipo",
};

export function editorialBadgeLabel(locale = "ko"): string {
  const language = locale.toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(badges, language) ? badges[language] : badges.en;
}

// Explicit content language only; never infer a locale from network location.
export function editorialDisplayName(locale = "ko"): string {
  const language = locale.toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(names, language) ? names[language] : names.en;
}

export function authorDisplayName(author: Author, locale = "ko"): string {
  return author.role === "editor" ? editorialDisplayName(locale) : author.name;
}
