/** Private working data. Never return these records from public endpoints. */
export interface ChatSourceInput {
  /** Opaque private identifier, not a filename. */
  id: string;
  bytes: Uint8Array;
}

export interface SourceRange {
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
}

export type ChatIssue =
  | "missing-date"
  | "missing-attachment"
  | "possible-truncation"
  | "header-like-body"
  | "fence-recovered"
  | "invalid-utf8"
  | "unrecognized-line";

export interface ChatTimestamp {
  /** Local export time, without an inferred timezone or invented seconds. */
  local: string;
  precision: "minute" | "second";
}

export interface ChatMessage {
  occurrenceId: string;
  sourceId: string;
  order: number;
  format: "bracket" | "inline";
  author: string;
  timestamp: ChatTimestamp | null;
  body: string;
  range: SourceRange;
  issues: ChatIssue[];
  /** Heuristic boundary repairs remain private and require review. */
  fenceIssues?: Array<{
    range: SourceRange;
    reason: "unclosed" | "recovered";
    resumedAt?: SourceRange;
  }>;
  attachments: Array<{ marker: string; range: SourceRange; available: false }>;
}

export interface ClassifiedRange extends SourceRange {
  kind:
    | "bom"
    | "header"
    | "date"
    | "message"
    | "system"
    | "attachment"
    | "unparsed";
  occurrenceId?: string;
  /** System metadata; source order is the original line order. */
  order?: number;
  text?: string;
  timestamp?: ChatTimestamp | null;
}

export interface ParsedChat {
  source: ChatSourceInput & {
    sha256: string;
    hasBom: boolean;
    format: "bracket" | "inline" | "mixed" | "unknown";
  };
  messages: ChatMessage[];
  unparsed: Array<{ text: string; range: SourceRange; issues: ChatIssue[] }>;
  classifiedRanges: ClassifiedRange[];
  manifest: {
    parserVersion: string;
    sourceId: string;
    sha256: string;
    byteLength: number;
    lineCount: number;
    coverage: { complete: boolean; coveredBytes: number; coveredLines: number };
    requiresReview: boolean;
  };
}

export interface DuplicateCandidate {
  leftOccurrenceId: string;
  rightOccurrenceId: string;
  status: "matched" | "ambiguous";
  reason:
    | "sequence-context"
    | "alias-or-incomplete"
    | "repeated-context"
    | "source-conflict";
}

export interface ChatDedupeResult {
  version: string;
  /** Includes singletons; no source occurrence is deleted. IDs depend on membership. */
  groups: Array<{ canonicalId: string; occurrenceIds: string[] }>;
  candidates: DuplicateCandidate[];
  /** Neither backup counts nor uncertain duplicates establish independent support. */
  independentSupportCount: null;
}
