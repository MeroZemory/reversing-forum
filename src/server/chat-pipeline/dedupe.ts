import { createHash } from "node:crypto";
import type {
  ChatDedupeResult,
  ChatMessage,
  ClassifiedRange,
  DuplicateCandidate,
  ParsedChat,
} from "./types";

export const CHAT_DEDUPE_VERSION = "chat-dedupe-v1";
const contextLength = 3;

function signature(message: ChatMessage): string {
  // Deliberately excludes author to detect alias uncertainty, never to merge it.
  return JSON.stringify([message.timestamp, message.body]);
}

function windows(messages: ChatMessage[]): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (let index = 0; index + contextLength <= messages.length; index++) {
    const key = JSON.stringify(
      messages.slice(index, index + contextLength).map(signature),
    );
    const entries = result.get(key) ?? [];
    entries.push(index);
    result.set(key, entries);
  }
  return result;
}

function interrupted(
  source: ParsedChat,
  barriers: ClassifiedRange[],
  start: number,
): boolean {
  const first = source.messages[start],
    last = source.messages[start + contextLength - 1];
  // Classified ranges are in byte order. Avoid scanning the entire export for
  // every overlapping context when processing large backups.
  let low = 0,
    high = barriers.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (barriers[middle].byteStart < first.range.byteStart) low = middle + 1;
    else high = middle;
  }
  return low < barriers.length && barriers[low].byteStart < last.range.byteEnd;
}

/** Conservative exact context correspondence; all original occurrences survive. */
export function dedupeChats(chats: readonly ParsedChat[]): ChatDedupeResult {
  const sources = [...chats].sort((a, b) =>
    a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0,
  );
  if (
    new Set(sources.map((source) => source.source.id)).size !== sources.length
  )
    throw new Error("duplicate-chat-source-id");
  const messages = sources.flatMap((source) => source.messages);
  const byId = new Map(
    messages.map((message) => [message.occurrenceId, message]),
  );
  if (byId.size !== messages.length)
    throw new Error("duplicate-chat-occurrence-id");
  const parent = new Map(
    messages.map((message) => [message.occurrenceId, message.occurrenceId]),
  );
  const members = new Map(
    messages.map((message) => [
      message.occurrenceId,
      new Set([message.sourceId]),
    ]),
  );
  function root(id: string): string {
    const next = parent.get(id)!;
    if (next === id) return id;
    const value = root(next);
    parent.set(id, value);
    return value;
  }
  const candidates = new Map<string, DuplicateCandidate>();
  const indices = sources.map((source) => windows(source.messages));
  const barriers = sources.map((source) =>
    source.classifiedRanges.filter(
      (range) => range.kind === "unparsed" || range.kind === "system",
    ),
  );
  const repetitions = sources.map((source) => {
    const counts = new Map<string, number>();
    for (const message of source.messages)
      counts.set(signature(message), (counts.get(signature(message)) ?? 0) + 1);
    return counts;
  });
  for (let a = 0; a < sources.length; a++) {
    for (let b = a + 1; b < sources.length; b++) {
      for (const [key, leftStarts] of indices[a]) {
        const rightStarts = indices[b].get(key);
        if (!rightStarts) continue;
        for (const leftStart of leftStarts)
          for (const rightStart of rightStarts) {
            const pairs = Array.from(
              { length: contextLength },
              (_, offset) =>
                [
                  sources[a].messages[leftStart + offset],
                  sources[b].messages[rightStart + offset],
                ] as const,
            );
            const repeated =
              leftStarts.length !== 1 ||
              rightStarts.length !== 1 ||
              pairs.some(
                ([left, right]) =>
                  repetitions[a].get(signature(left))! > 1 ||
                  repetitions[b].get(signature(right))! > 1,
              );
            const incomplete =
              interrupted(sources[a], barriers[a], leftStart) ||
              interrupted(sources[b], barriers[b], rightStart) ||
              pairs.some(
                ([left, right]) =>
                  !left.timestamp ||
                  !right.timestamp ||
                  left.author !== right.author ||
                  left.issues.length > 0 ||
                  right.issues.length > 0,
              );
            const reason = repeated
              ? "repeated-context"
              : incomplete
                ? "alias-or-incomplete"
                : "sequence-context";
            for (const [left, right] of pairs) {
              const candidateKey = JSON.stringify([
                left.occurrenceId,
                right.occurrenceId,
              ]);
              const candidate: DuplicateCandidate = {
                leftOccurrenceId: left.occurrenceId,
                rightOccurrenceId: right.occurrenceId,
                status: reason === "sequence-context" ? "matched" : "ambiguous",
                reason,
              };
              // An ambiguous overlapping window cannot be overridden by another window.
              if (candidates.get(candidateKey)?.status !== "ambiguous")
                candidates.set(candidateKey, candidate);
            }
          }
      }
    }
  }
  const ordered = [...candidates.values()].sort((a, b) => {
    const left = `${a.leftOccurrenceId}:${a.rightOccurrenceId}`,
      right = `${b.leftOccurrenceId}:${b.rightOccurrenceId}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const candidate of ordered) {
    if (candidate.status !== "matched") continue;
    const leftRoot = root(candidate.leftOccurrenceId),
      rightRoot = root(candidate.rightOccurrenceId);
    if (leftRoot === rightRoot) continue;
    const leftSources = members.get(leftRoot)!,
      rightSources = members.get(rightRoot)!;
    if ([...rightSources].some((id) => leftSources.has(id))) {
      candidate.status = "ambiguous";
      candidate.reason = "source-conflict";
      continue;
    }
    parent.set(rightRoot, leftRoot);
    for (const id of rightSources) leftSources.add(id);
  }
  const groups = new Map<string, string[]>();
  for (const message of messages) {
    const id = root(message.occurrenceId),
      group = groups.get(id) ?? [];
    group.push(message.occurrenceId);
    groups.set(id, group);
  }
  return {
    version: CHAT_DEDUPE_VERSION,
    groups: [...groups.values()]
      .map((ids) => {
        const occurrenceIds = ids.sort();
        return {
          canonicalId: createHash("sha256")
            .update(JSON.stringify([CHAT_DEDUPE_VERSION, occurrenceIds]))
            .digest("hex"),
          occurrenceIds,
        };
      })
      .sort((a, b) =>
        a.canonicalId < b.canonicalId
          ? -1
          : a.canonicalId > b.canonicalId
            ? 1
            : 0,
      ),
    candidates: ordered,
    independentSupportCount: null,
  };
}
