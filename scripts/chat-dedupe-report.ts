import Database from "better-sqlite3";
const db = new Database("data/chat-pipeline/jobs.sqlite", { readonly: true });
const row = db
  .prepare(
    "SELECT record FROM dedupe d JOIN runs r ON r.id=d.run_id WHERE r.active=1",
  )
  .get() as { record: string };
const report = JSON.parse(row.record) as {
  candidates: { status: string; reason: string }[];
  groups: { occurrenceIds: string[] }[];
};
const reasons: Record<string, number> = {};
for (const c of report.candidates)
  reasons[`${c.status}:${c.reason}`] =
    (reasons[`${c.status}:${c.reason}`] || 0) + 1;
const sources = db
  .prepare(
    "SELECT s.id FROM sources s JOIN runs r ON r.id=s.run_id WHERE r.active=1 ORDER BY s.id",
  )
  .all() as { id: string }[];
const messages = sources.map((s) =>
  (
    db
      .prepare(
        "SELECT o.record FROM occurrences o WHERE json_extract(o.record,'$.sourceId')=?",
      )
      .all(s.id) as { record: string }[]
  ).map((r) => JSON.parse(r.record)),
);
const overlap = [];
for (let a = 0; a < messages.length; a++)
  for (let b = a + 1; b < messages.length; b++) {
    const index = new Map(
      messages[a].map((m) => [
        JSON.stringify([
          m.timestamp?.local,
          m.body.replace(/\r\n/g, "\n").replace(/\n+$/, ""),
        ]),
        m,
      ]),
    );
    let contentMatches = 0,
      sameAuthor = 0,
      sameIssues = 0,
      exactBody = 0;
    for (const m of messages[b]) {
      const other = index.get(
        JSON.stringify([
          m.timestamp?.local,
          m.body.replace(/\r\n/g, "\n").replace(/\n+$/, ""),
        ]),
      );
      if (other) {
        contentMatches++;
        if (m.author === other.author) sameAuthor++;
        if (!m.issues.length && !other.issues.length) sameIssues++;
        if (m.body === other.body) exactBody++;
      }
    }
    overlap.push({
      a,
      b,
      contentMatches,
      sameAuthor,
      neitherHasIssues: sameIssues,
      exactBody,
    });
  }
console.log(
  JSON.stringify({
    reasons,
    groupedOccurrences: report.groups.filter((g) => g.occurrenceIds.length > 1)
      .length,
    overlap,
  }),
);
db.close();
