const supplementHeading = /\n#{2,3} 편집자 보충/;

export function plainExcerpt(body: string): string {
  return ("\n" + body)
    .split(supplementHeading)[0]
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6} .*$/gm, "")
    .replace(/^\s*[-*+] /gm, "")
    .replace(/^\s*\d+[.)] /gm, "")
    .replace(/^\|.*\|$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^출처:.*$/gm, "")
    .replace(/<[^>]*>/g, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

// Supplement sources are display metadata, never screening evidence.
export function supplementSourceCount(body: string): number {
  const supplement = ("\n" + body).split(supplementHeading).slice(1).join("\n");
  const line = supplement.match(/^출처:.*$/m)?.[0] ?? "";
  return [...line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)].length;
}
