// Display/query aliases only; stored tags are never rewritten.
export const topicAliases: Record<string, readonly string[]> = {
  리버싱: ["리버스 엔지니어링", "역공학"],
  "악성코드 분석": ["악성 코드 분석"],
  악성코드: ["악성 코드"],
  Windows: ["윈도우"],
  Linux: ["리눅스"],
  OllyDbg: ["올리디버거"],
  IDA: ["IDA Pro"],
  Android: ["안드로이드"],
  PEview: ["PEView"],
  운영체제: ["운영 체제"],
  "Windows API": ["윈도 API"],
};
const canonical = new Map(
  Object.entries(topicAliases).flatMap(([name, aliases]) =>
    [name, ...aliases].map((tag) => [tag.toLowerCase(), name] as const),
  ),
);

export function canonicalTopic(tag: string): string {
  const value = tag.trim();
  return canonical.get(value.toLowerCase()) ?? value;
}

export function topicVariants(tag: string): string[] {
  const name = canonicalTopic(tag);
  const aliases = Object.hasOwn(topicAliases, name) ? topicAliases[name] : [];
  return [...new Set([name, ...aliases])];
}
