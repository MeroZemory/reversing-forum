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
            messageOrder: unknown;
          }
        | undefined;
      if (!evidence || evidence.held || !chronology)
        throw new Error("editorial-evidence-unavailable");
      return { evidence, chronology };
    })
    .sort((a, b) => a.chronology.position - b.chronology.position);
  const starts = new Set(
    relativeSegmentStarts(
      selected.map(({ evidence, chronology }, index) => ({
        index,
        local: chronology.local,
        sourceId: chronology.sourceId,
        order: chronology.messageOrder,
        duplicateAmbiguous: evidence.duplicateAmbiguous,
      })),
    ),
  );
  let segment = -1;
  const evidence = selected.map(({ evidence: value }, index) => {
    if (starts.has(index)) segment++;
    const { id, speaker, text, attachmentMissing, duplicateAmbiguous, held } =
      value;
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
