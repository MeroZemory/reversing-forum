export type BodyHeading = {
  id: string;
  text: string;
  offset: number;
  level: number;
};
export type BodySection = { body: string; offset: number; supplement: boolean };

function headings(body: string) {
  const result: { text: string; offset: number; level: number }[] = [];
  let offset = 0;
  let fence: { character: string; length: number } | undefined;
  for (const line of body.split(/(?<=\n)/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        !line.slice(marker[0].length).trim()
      )
        fence = undefined;
    } else if (!fence) {
      const match = line.match(
        /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*\r?\n?$/,
      );
      if (match)
        result.push({ level: match[1].length, text: match[2], offset });
    }
    offset += line.length;
  }
  return result;
}

export function bodyHeadings(
  body: string,
  prefix = "body-section",
): BodyHeading[] {
  return headings(body)
    .filter((h) => h.level <= 2)
    .map((h, index) => ({
      ...h,
      id: `${prefix}-${index + 1}`,
      text: h.text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[`*_~]/g, ""),
    }));
}

export function bodySections(body: string): BodySection[] {
  const all = headings(body),
    sections: BodySection[] = [];
  let cursor = 0;
  for (let index = 0; index < all.length; index++) {
    const heading = all[index];
    if (
      heading.offset < cursor ||
      ![2, 3].includes(heading.level) ||
      heading.text.trim() !== "편집자 보충"
    )
      continue;
    const end =
      all.slice(index + 1).find((h) => h.level <= heading.level)?.offset ??
      body.length;
    if (heading.offset > cursor)
      sections.push({
        body: body.slice(cursor, heading.offset),
        offset: cursor,
        supplement: false,
      });
    sections.push({
      body: body.slice(heading.offset, end),
      offset: heading.offset,
      supplement: true,
    });
    cursor = end;
  }
  if (cursor < body.length || !sections.length)
    sections.push({
      body: body.slice(cursor),
      offset: cursor,
      supplement: false,
    });
  return sections;
}
