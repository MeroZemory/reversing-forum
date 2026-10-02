import type { ReactNode } from "react";
import type {
  Comment,
  PostKind,
  PostPurpose,
  PostStatus,
  Author,
} from "./types";
export type CreatePostCommand = {
  title: string;
  body: string;
  kind: PostKind;
  tags: string[];
};
export type CreatePostResult = { id: string; status: PostStatus };
export type CreateCommentCommand = { body: string; parentId: string | null };
export type AuthCommand = { name?: string; email: string; password: string };
export type AuthMode = "login" | "register";
export type PostFormProps = {
  viewerId: string;
  initialPurpose?: PostPurpose;
  initialTag?: string;
  from?: string;
};
export type PostFormState = {
  busy: boolean;
  error: string;
  title: string;
  body: string;
  tags: string;
  kind: PostKind;
  preview: boolean;
  saved: boolean;
  restored: boolean;
  setTitle(value: string): void;
  setBody(value: string): void;
  setTags(value: string): void;
  setKind(value: PostKind): void;
  setPreview(value: boolean): void;
  submit(): Promise<void>;
};
export type CommentComposerProps = {
  postId: string;
  parentId?: string;
  viewerId: string;
  postPath: string;
  onDone?: () => void;
};
export type CommentComposerState = {
  busy: boolean;
  error: string;
  body: string;
  needsLogin: boolean;
  draftStored: boolean;
  setBody(value: string): void;
  submit(reset: () => void): Promise<void>;
  rememberReply(): void;
  loginHref: string;
};
export type CommentFormViewProps = {
  parentId?: string;
  label: string;
  placeholder: string;
  state: CommentComposerState;
};
export type CommentSectionProps = {
  postId: string;
  comments: Comment[];
  viewer: Author | null;
  postPath: string;
  purpose: PostPurpose;
};
export type ComposerSlot = {
  parentId?: string;
  label: string;
  placeholder: string;
  onDone?: () => void;
};
export type CommentSectionViewProps = Omit<
  CommentSectionProps,
  "postId" | "postPath"
> & {
  replyingTo: string | null;
  setReplyingTo(value: string | null): void;
  loginHref: string;
  renderComposer(props: ComposerSlot): ReactNode;
};
export type AuthFormProps = { mode: AuthMode; returnTo?: string };
export type AuthFormState = {
  busy: boolean;
  error: string;
  destination: string;
  submit(command: AuthCommand, onValidationError?: () => void): Promise<void>;
};
export type AccountButtonState = {
  busy: boolean;
  error: boolean;
  signOut(): Promise<void>;
};
