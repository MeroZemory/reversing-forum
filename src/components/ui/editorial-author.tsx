import type { Author } from "@/lib/types";
import { authorDisplayName, editorialBadgeLabel } from "@/lib/editorial-labels";

export function EditorialAuthor({
  author,
  locale = "ko",
}: {
  author: Author;
  locale?: string;
}) {
  return (
    <span className="editorial-author">
      <span>{authorDisplayName(author, locale)}</span>
      {author.role === "editor" && (
        <span className="editorial-account-badge">
          {editorialBadgeLabel(locale)}
        </span>
      )}
    </span>
  );
}
