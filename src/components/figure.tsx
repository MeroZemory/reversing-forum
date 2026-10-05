export function Figure({
  src,
  alt,
  caption,
}: {
  src: string;
  alt: string;
  caption?: string;
}) {
  return (
    <figure>
      <a href={src} rel="nofollow ugc noopener noreferrer">
        {alt || "첨부 이미지 링크"}
      </a>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
