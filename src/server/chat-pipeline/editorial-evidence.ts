import type Database from "better-sqlite3";
import { relativeSegmentStarts } from "./relative-context";

export type EditorialEvidence = {
  id: string;
  speaker: string;
  text: string;
  attachmentMissing: boolean;
  duplicateAmbiguous: boolean;
  held: boolean;
};

/** Dates and source identifiers remain local; only sequence and segment reach a model. */
export function editorialEvidence(
  db: Database.Database,
  ids: readonly string[],
  minimized: ReadonlyMap<string, EditorialEvidence>,
) {
  const query = db.prepare(`SELECT position,
    json_extract(record,'$.message.timestamp.local') AS local,
    json_extract(record,'$.message.sourceId') AS sourceId,
    json_extract(record,'$.message.author') AS author,
    json_extract(record,'$.message.order') AS messageOrder
    FROM ledger WHERE run_id=(SELECT id FROM runs WHERE active=1) AND id=?`);
  const selected = [...new Set(ids)]
    .map((id) => {
      const evidence = minimized.get(id);
      const chronology = query.get(id) as
        | {
            position: number;
            local: unknown;
            sourceId: unknown;
            author: unknown;
            messageOrder: unknown;
          }
        | undefined;
      if (!evidence || evidence.held || !chronology)
        throw new Error("editorial-evidence-unavailable");
      return { evidence, chronology };
    })
    .sort((a, b) => a.chronology.position - b.chronology.position);
  // Ledger order interleaves occurrences from overlapping backups. Preserve
  // each export's own order without asserting that occurrences across exports
  // represent the same message or author.
  const sourceLanes = new Map<string, number>();
  const incompleteOrderLanes = new Set<string>();
  const sourceKey = (value: (typeof selected)[number]) =>
    typeof value.chronology.sourceId === "string" && value.chronology.sourceId
      ? JSON.stringify(["source", value.chronology.sourceId])
      : JSON.stringify(["unknown", value.evidence.id]);
  for (const value of selected) {
    const key = sourceKey(value);
    if (!sourceLanes.has(key)) sourceLanes.set(key, sourceLanes.size);
    if (
      typeof value.chronology.messageOrder !== "number" ||
      !Number.isSafeInteger(value.chronology.messageOrder) ||
      value.chronology.messageOrder < 0
    )
      incompleteOrderLanes.add(key);
  }
  const sourceOrder = (value: (typeof selected)[number]) =>
    !incompleteOrderLanes.has(sourceKey(value)) &&
    typeof value.chronology.messageOrder === "number"
      ? value.chronology.messageOrder
      : value.chronology.position;
  selected.sort(
    (a, b) =>
      sourceLanes.get(sourceKey(a))! - sourceLanes.get(sourceKey(b))! ||
      sourceOrder(a) - sourceOrder(b) ||
      a.chronology.position - b.chronology.position,
  );
  const starts = new Set(
    relativeSegmentStarts(
      selected.map(({ evidence, chronology }, index) => ({
        index,
        local: chronology.local,
        sourceId: chronology.sourceId,
        order: chronology.messageOrder,
        // Cross-backup matching uncertainty does not erase known order in
        // one export. The uncertainty flag still reaches the reviewer below.
      })),
    ),
  );
  let segment = -1;
  const speakers = new Map<string, string>();
  const evidence = selected.map(({ evidence: value, chronology }, index) => {
    if (starts.has(index)) segment++;
    const { id, text, attachmentMissing, duplicateAmbiguous, held } = value;
    // Aliases in prepared batches are reused. Scope fresh labels to this candidate;
    // nickname changes never establish that two identities are the same person.
    const privateAuthor = JSON.stringify([
      typeof chronology.sourceId === "string" ? chronology.sourceId : id,
      typeof chronology.author === "string" ? chronology.author : id,
    ]);
    if (!speakers.has(privateAuthor))
      speakers.set(privateAuthor, `발언자${speakers.size + 1}`);
    const speaker = speakers.get(privateAuthor)!;
    return {
      id,
      speaker,
      text,
      attachmentMissing,
      duplicateAmbiguous,
      held,
      segment,
    };
  });
  const months = selected
    .map(({ chronology }) =>
      typeof chronology.local === "string" ? chronology.local.slice(0, 7) : "",
    )
    .filter((month) => /^\d{4}-\d{2}$/.test(month))
    .sort();
  const format = (month: string) =>
    `${month.slice(0, 4)}년 ${Number(month.slice(5))}월`;
  const period = months.length
    ? format(months[0]) +
      (months.at(-1) !== months[0] ? ` ~ ${format(months.at(-1)!)}` : "")
    : "기록 시기 미확인";
  return { evidence, period };
}
