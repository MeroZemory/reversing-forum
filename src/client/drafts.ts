export function readDraft(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
export function saveDraft(key: string, value: string): boolean {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
export const postDraftKey = (viewerId: string) =>
  `reversing-all:draft:${viewerId}`;
export const commentDraftKey = (
  viewerId: string,
  postId: string,
  parentId?: string,
) => `reversing-all:comment:${viewerId}:${postId}:${parentId || "root"}`;
export const resumeReplyKey = (viewerId: string, postId: string) =>
  `reversing-all:resume-reply:${viewerId}:${postId}`;
